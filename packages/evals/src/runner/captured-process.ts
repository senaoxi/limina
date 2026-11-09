import { spawn } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentExecution } from '../core/outcome.ts';
import { captureSnapshot, sha256, type Snapshot } from '../core/snapshot.ts';
import type { WorkspaceVolume } from './workspace-volume.ts';

// One deadline covers revoking writers, capturing S1 and checking protected runtime files.
export async function beforeCaptureDeadline<T>(
  until: number,
  work: () => Promise<T>,
): Promise<T> {
  const remaining = until - performance.now();
  if (remaining <= 0) throw new Error('CAPTURE_DEADLINE');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('CAPTURE_DEADLINE')),
          remaining,
        );
      }),
    ]);
    if (performance.now() >= until) throw new Error('CAPTURE_DEADLINE');
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/**
Own the process, continuous logs and final capture on every exit path.
*/
export async function executeCapturedProcess(input: {
  identity: { executable: string };
  args: string[];
  environment: NodeJS.ProcessEnv;
  stdin?: string;
  volume: WorkspaceVolume;
  evidenceDirectory: string;
  excludedRoots: string[];
  timeoutMs?: number;
}): Promise<{
  execution: AgentExecution;
  agentMs: number;
  s1: Snapshot;
  events: unknown[];
  captureEndsAt: number;
}> {
  const stdoutFd = openSync(
    path.join(input.evidenceDirectory, 'events.jsonl'),
    'wx',
    0o600,
  );
  const stderrFd = openSync(
    path.join(input.evidenceDirectory, 'stderr.log'),
    'wx',
    0o600,
  );
  let execution: AgentExecution;
  let s1: Snapshot = {
    version: 1,
    stage: 'S1',
    status: 'unknown',
    entries: [],
    excludedRoots: input.excludedRoots,
    digest: null,
    errors: [],
  };
  const events: unknown[] = [];
  let pendingLine = '';
  let bytes = 0;
  let hasLogFailure = false;
  let hasTimedOut = false;
  const startedAt = performance.now();
  let agentMs: number;
  let captureEndsAt: number;
  const child = spawn(input.identity.executable, input.args, {
    env: input.environment,
    cwd: input.volume.workspace,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /*
        already exited
        */
      }
    }
  };
  const timer = setTimeout(
    () => {
      hasTimedOut = true;
      killGroup();
    },
    input.timeoutMs ?? 15 * 60_000,
  );
  const log = (fd: number, chunk: string) => {
    try {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) throw new Error('Trace limit');
      writeSync(fd, chunk);
      fsyncSync(fd);
    } catch {
      hasLogFailure = true;
      killGroup();
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    log(stdoutFd, chunk);
    pendingLine += chunk;
    while (pendingLine.includes('\n')) {
      const index = pendingLine.indexOf('\n');
      const line = pendingLine.slice(0, index);
      pendingLine = pendingLine.slice(index + 1);
      try {
        events.push(JSON.parse(line));
      } catch {
        hasLogFailure = true;
      }
    }
  });
  child.stderr.on('data', (chunk: string) => log(stderrFd, chunk));
  child.stdin.on('error', () => {
    /*
    Exit/error owns classification; never retry the model call.
    */
  });
  child.stdin.end(input.stdin ?? '');
  try {
    execution = await new Promise<AgentExecution>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (
          child.pid !== undefined ||
          !['ENOENT', 'EACCES'].includes(error.code ?? '')
        ) {
          resolve({ status: 'error' });
          return;
        }
        // Native spawn failed before any child existed. Do not infer this from a CLI exit or a prompt.
        const bytes = `${JSON.stringify({
          phase: 'setup',
          source: 'controller-child-process',
          pid: null,
          executable: input.identity.executable,
          code: error.code,
          syscall: error.syscall,
        })}\n`;
        try {
          writeFileSync(
            path.join(input.evidenceDirectory, 'infrastructure.json'),
            bytes,
            { flag: 'wx', mode: 0o600 },
          );
          resolve({
            status: 'infra_error',
            evidence: { phase: 'setup', recordId: sha256(bytes) },
          });
        } catch {
          resolve({ status: 'unknown' });
        }
      });
      child.once('exit', (code) =>
        resolve(
          hasTimedOut
            ? { status: 'timeout' }
            : code === null
              ? { status: 'error' }
              : { status: 'completed', exitCode: code },
        ),
      );
    });
  } finally {
    agentMs = performance.now() - startedAt;
    captureEndsAt = performance.now() + 120_000;
    clearTimeout(timer);
    killGroup();
    await new Promise<void>((resolve) => {
      if (child.stdout.readableEnded && child.stderr.readableEnded) {
        resolve();
        return;
      }
      const drainDeadline = setTimeout(() => {
        hasLogFailure = true;
        resolve();
      }, 2000);
      child.once('close', () => {
        clearTimeout(drainDeadline);
        resolve();
      });
    });
    // Detach revokes surviving file descriptors, including escaped process groups.
    try {
      const frozen = input.volume.freeze();
      s1 = await beforeCaptureDeadline(captureEndsAt, () =>
        captureSnapshot(frozen.root, 'S1', {
          excludedRoots: input.excludedRoots,
        }),
      );
    } catch (error) {
      s1.errors.push({
        path: '',
        code:
          error instanceof Error && error.message === 'CAPTURE_DEADLINE'
            ? 'CAPTURE_DEADLINE'
            : 'WORKSPACE_FREEZE_FAILED',
      });
    }
    child.stdout.destroy();
    child.stderr.destroy();
    closeSync(stdoutFd);
    closeSync(stderrFd);
    writeFileSync(
      path.join(input.evidenceDirectory, 'S1.json'),
      `${JSON.stringify(s1)}\n`,
      { mode: 0o600 },
    );
  }
  if (
    (hasLogFailure || pendingLine.trim()) &&
    execution.status === 'completed' &&
    execution.exitCode === 0
  )
    execution = { status: 'error' };
  return { execution, agentMs, s1, events, captureEndsAt };
}
