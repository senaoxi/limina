import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GradingDeadline, GradingDeadlineExceeded } from '../core/deadline.ts';
import {
  type ReconstructedProject,
  verifyReconstructedProject,
} from '../core/reconstruction.ts';
import { pnpmRuntimeArguments } from './pnpm-tool.ts';

const execute = promisify(execFile);
export interface DockerIdentity {
  executable: string;
  endpoint: string;
  configDirectory: string;
  image: string;
  // A fresh anonymous volume is populated only from the pinned image, never
  // from Agent node_modules or a host directory. Docker mounts it read-only.
  projectDependencies?: 'image-volume';
  // Frozen per-task resources; every compared condition uses the same limit.
  memoryMiB?: 1024 | 2048;
}
export interface CommandEvidence {
  executable: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
Project code runs as an unprivileged user in a disposable, offline container.
This executor returns observations, never a score. Hidden assertions stay in
the controller and cannot be supplied through the project command arguments.
*/
export class DockerVerifier {
  #started = false;
  #closed = false;
  #disposal: Promise<void> | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  readonly commands: CommandEvidence[] = [];
  readonly deadline: GradingDeadline;
  readonly identity: DockerIdentity;
  readonly name = `limina-eval-${randomUUID()}`;

  constructor(identity: DockerIdentity, deadline = new GradingDeadline()) {
    if (!/^(?:node@)?sha256:[a-f\d]{64}$/.test(identity.image))
      throw new Error(
        'Verifier requires a pinned registry digest or local image ID',
      );
    if (
      !identity.endpoint.startsWith('unix:///') ||
      !path.isAbsolute(identity.executable) ||
      !path.isAbsolute(identity.configDirectory)
    )
      throw new Error('Verifier requires explicit local Docker paths');
    this.identity = identity;
    if (
      identity.projectDependencies !== undefined &&
      identity.projectDependencies !== 'image-volume'
    )
      throw new Error('Unsupported verifier dependency layout');
    if (
      identity.memoryMiB !== undefined &&
      ![1024, 2048].includes(identity.memoryMiB)
    )
      throw new Error('Unsupported verifier memory limit');
    this.deadline = deadline;
  }

  async #docker(
    commandArguments: string[],
    timeout = 30_000,
    input?: Uint8Array,
    isCleanup = false,
  ) {
    if (!isCleanup && this.#closed) throw new GradingDeadlineExceeded();
    const boundedTimeout = isCleanup ? timeout : this.deadline.timeout(timeout);
    const result = execute(
      this.identity.executable,
      [
        '--config',
        this.identity.configDirectory,
        '--host',
        this.identity.endpoint,
        ...commandArguments,
      ],
      {
        env: { PATH: '/usr/bin:/bin', HOME: this.identity.configDirectory },
        encoding: 'utf8',
        timeout: boundedTimeout,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    this.#pending.add(result);
    result.child.stdin?.end(input);
    try {
      const completed = await result;
      if (result.child.killed)
        throw Object.assign(new Error('Docker client timed out'), {
          killed: true,
          stdout: completed.stdout,
          stderr: completed.stderr,
        });
      if (!isCleanup && this.deadline.remaining() === 0)
        throw Object.assign(new GradingDeadlineExceeded(), completed);
      return completed;
    } finally {
      this.#pending.delete(result);
    }
  }

  async start(project: ReconstructedProject): Promise<void> {
    if (this.#started || this.#closed)
      throw new Error('Verifier already started or closed');
    this.deadline.timeout(1);
    await verifyReconstructedProject(project);
    const validatedProject = project.directory;
    const projectStat = await lstat(validatedProject);
    if (
      (await realpath(validatedProject)) !== validatedProject ||
      !projectStat.isDirectory()
    )
      throw new Error(
        'Verifier project must be a real controller-owned directory',
      );
    // The caller reconstructs this directory only after TaskSpec validation.
    // No host bind mounts, HOME, sockets, credentials or Grader files enter it.
    this.#started = true;
    try {
      await this.#docker([
        'create',
        '--name',
        this.name,
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--pids-limit',
        '128',
        '--memory',
        `${this.identity.memoryMiB ?? 1024}m`,
        '--cpus',
        '1',
        '--tmpfs',
        '/workspace:rw,nosuid,nodev,uid=1000,gid=1000,size=512m',
        ...(this.identity.projectDependencies === 'image-volume'
          ? [
              '--mount',
              'type=volume,destination=/workspace/node_modules,readonly',
            ]
          : []),
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=128m',
        '--workdir',
        '/workspace',
        '--env',
        'HOME=/tmp',
        '--env',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        '--env',
        'npm_config_verify_deps_before_run=false',
        '--env',
        'npm_config_ignore_scripts=true',
        '--env',
        'npm_config_offline=true',
        '--entrypoint',
        '/usr/local/bin/node',
        this.identity.image,
        '-e',
        'setInterval(() => {}, 60000)',
      ]);
      await this.#docker(['start', this.name]);
      const archive = await execute(
        '/usr/bin/tar',
        [
          '-cf',
          '-',
          '--uid',
          '1000',
          '--gid',
          '1000',
          '-C',
          validatedProject,
          '.',
        ],
        {
          env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
          encoding: 'buffer',
          maxBuffer: 128 * 1024 * 1024,
          timeout: this.deadline.timeout(30_000),
        },
      );
      await this.#docker(
        [
          'exec',
          '-i',
          '--user',
          '1000:1000',
          this.name,
          '/bin/tar',
          '-xf',
          '-',
          '-C',
          '/workspace',
          '--no-same-owner',
        ],
        30_000,
        archive.stdout,
      );
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async command(
    executable: '/usr/local/bin/node' | '/usr/local/bin/pnpm',
    commandArguments: string[],
    timeoutMs = 300_000,
  ): Promise<CommandEvidence> {
    const fixedArguments =
      executable === '/usr/local/bin/pnpm'
        ? pnpmRuntimeArguments(commandArguments)
        : commandArguments;
    const record = (evidence: CommandEvidence) => {
      this.commands.push(evidence);
      return evidence;
    };
    if (this.deadline.remaining() === 0 || this.#closed) {
      await this.dispose();
      return record({
        executable,
        args: fixedArguments,
        exitCode: null,
        stdout: '',
        stderr: 'Verifier phase is closed or expired',
        timedOut: true,
      });
    }
    if (!this.#started) throw new Error('Verifier is not running');
    try {
      const result = await this.#docker(
        [
          'exec',
          '--user',
          '1000:1000',
          '--workdir',
          '/workspace',
          this.name,
          executable,
          ...fixedArguments,
        ],
        timeoutMs,
      );
      return record({
        executable,
        args: fixedArguments,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
      });
    } catch (error) {
      const failure = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      const hasTimedOut =
        failure.killed === true ||
        error instanceof GradingDeadlineExceeded ||
        this.deadline.remaining() === 0;
      const evidence = record({
        executable,
        args: fixedArguments,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        timedOut: hasTimedOut,
      });
      if (hasTimedOut) await this.dispose();
      return evidence;
    }
  }

  async inspectIsolation(): Promise<unknown> {
    const result = await this.#docker(['inspect', this.name]);
    const [container] = JSON.parse(result.stdout) as {
      Config: { User: string; Env: string[] };
      HostConfig: {
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        Binds: unknown;
        CapDrop: string[];
        SecurityOpt: string[];
      };
      Mounts: unknown[];
    }[];
    if (!container) throw new Error('Verifier inspection missing');
    return {
      user: container.Config.User,
      environment: container.Config.Env,
      host: container.HostConfig,
      mounts: container.Mounts,
    };
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    if (this.#disposal) return this.#disposal;
    if (!this.#started) return undefined;
    this.#disposal = (async () => {
      await Promise.allSettled(this.#pending);
      try {
        await this.#docker(
          ['rm', '-f', '-v', this.name],
          30_000,
          undefined,
          true,
        );
      } catch (error) {
        const failure = error as { stderr?: string };
        if (!/no such container/i.test(failure.stderr ?? '')) throw error;
      }
      this.#started = false;
    })();
    return this.#disposal;
  }
}
