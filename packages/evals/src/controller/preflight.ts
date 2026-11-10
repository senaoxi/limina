import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { BudgetManager } from '../core/budget.ts';
import { contentIdentity } from '../core/identity.ts';
import type { ModelProfile } from '../core/model-profile.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import { reconstructForVerifier } from '../core/reconstruction.ts';
import {
  assertRelativePath,
  captureSnapshot,
  sha256,
} from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import {
  type DockerIdentity,
  DockerVerifier,
} from '../runner/docker-verifier.ts';
import {
  codexEnvironment,
  type CodexIdentity,
  inspectAccount,
  localCodexArguments,
  prepareCodexHome,
  taskTools,
  verifyCodex,
  verifyPinnedModelCatalog,
  verifyPromptInput,
} from '../runner/local-codex.ts';
import {
  type BinaryIdentity,
  type PreparedInputs,
  verifyBinary,
} from './prepare.ts';

const execute = promisify(execFile);

export interface FoundationPreflightConfig {
  version: 1;
  scope: 'foundation';
  modelProfile?: ModelProfile;
  controllerDirectory: string;
  preparedDirectory: string;
  authHome: string;
  codex: CodexIdentity;
  node: BinaryIdentity;
  pnpm: BinaryIdentity;
  docker: DockerIdentity & { sha256: string; version: string };
  runtimeBundle: { directory: string; digest: string };
}

export async function verifyPreparedInputs(
  directory: string,
): Promise<PreparedInputs> {
  if (!path.isAbsolute(directory) || (await realpath(directory)) !== directory)
    throw new Error('Prepared input directory must be canonical');
  const prepared = JSON.parse(
    await readFile(path.join(directory, 'prepared.json'), 'utf8'),
  ) as PreparedInputs;
  const { identity, ...body } = prepared;
  if (
    prepared.version !== 1 ||
    contentIdentity(body) !== identity ||
    contentIdentity(prepared.repository.files) !==
      prepared.repository.contentDigest
  )
    throw new Error('Prepared manifest identity mismatch');
  const source = await captureSnapshot(path.join(directory, 'source'), 'F0', {
    maxBytes: 256 * 1024 * 1024,
    maxEntries: 20_000,
  });
  const files = source.entries.filter((entry) => entry.kind !== 'directory');
  const expected = prepared.repository.files.filter(
    (file) => file.sha256 !== null,
  );
  if (
    source.status !== 'complete' ||
    files.length !== expected.length ||
    expected.some((file) =>
      files.every(
        (entry) =>
          !(
            entry.path === file.path &&
            entry.kind === 'file' &&
            entry.sha256 === file.sha256 &&
            entry.mode === file.mode
          ),
      ),
    )
  )
    throw new Error('Frozen repository bytes or modes changed');
  for (const artifact of prepared.artifacts) {
    assertRelativePath(artifact.path);
    const file = path.join(directory, artifact.path);
    if (
      (await realpath(file)) !== file ||
      sha256(await readFile(file)) !== artifact.sha256
    )
      throw new Error('Frozen product artifact changed');
  }
  if (
    prepared.artifacts.length !== 2 ||
    ['limina', 'limina-migrate'].some(
      (name) =>
        prepared.artifacts.filter((artifact) => artifact.name === name)
          .length !== 1,
    )
  )
    throw new Error('Missing or duplicated product artifact');
  const skill = await captureSnapshot(
    path.join(directory, 'source/skills/limina'),
    'F0',
  );
  if (skill.status !== 'complete' || skill.digest !== prepared.skillDigest)
    throw new Error('Frozen Skill identity changed');
  return prepared;
}

function isWithin(root: string, child: string): boolean {
  return child === root || child.startsWith(`${root}${path.sep}`);
}

async function nativeIsolation(
  config: FoundationPreflightConfig,
  directory: string,
) {
  const workspace = path.join(directory, 'sandbox-workspace');
  const client = path.join(directory, 'sandbox-client');
  await mkdir(workspace);
  await mkdir(client);
  await mkdir(path.join(workspace, '.agents'));
  await mkdir(path.join(workspace, 'node_modules'));
  await writeFile(
    path.join(workspace, 'node_modules', 'frozen.txt'),
    'FROZEN_DEPENDENCY_CANARY',
  );
  await symlink(
    'node_modules/frozen.txt',
    path.join(workspace, 'dependency-alias'),
  );
  await writeFile(
    path.join(workspace, 'allowed.txt'),
    'workspace positive control',
  );
  const canary = path.join(
    config.authHome,
    '.codex',
    `limina-eval-canary-${randomUUID()}`,
  );
  const controllerCanary = path.join(directory, 'controller-canary');
  await writeFile(controllerCanary, 'NON_SECRET_CONTROLLER_CANARY', {
    flag: 'wx',
    mode: 0o600,
  });
  const { readableToolRoots: roots, toolDirectories } = taskTools(
    workspace,
    config.node.executable,
    config.pnpm.executable,
  );
  for (const root of roots) {
    const canonical = await realpath(root);
    if (
      canonical !== root ||
      isWithin(root, canary) ||
      isWithin(root, controllerCanary)
    )
      throw new Error(
        'Tool root exposes protected controller or credential paths',
      );
  }
  const invocation = localCodexArguments(workspace, roots);
  const overrides: string[] = [];
  for (let index = 0; index < invocation.length; index++)
    if (invocation[index] === '-c') overrides.push('-c', invocation[++index]!);
  const rounds = [
    {
      id: 'direct-host-denial',
      command: [
        '/bin/sh',
        '-c',
        'cat allowed.txt >/dev/null && echo ok > created.txt && cat node_modules/frozen.txt >/dev/null && ! echo changed > node_modules/frozen.txt && ! cat "$1" && ! cat "$2"',
        'probe',
        canary,
        controllerCanary,
      ],
    },
    {
      id: 'symlink-and-child-denial',
      command: [
        '/bin/sh',
        '-c',
        '! cat alias && ! mv node_modules moved-dependencies && ! rm node_modules/frozen.txt && /bin/sh -c \'! cat "$1"\' child "$1"',
        'probe',
        canary,
      ],
    },
    {
      id: 'independent-runtime-denial',
      command: [
        config.node.executable,
        '-e',
        "const fs=require('fs');fs.writeFileSync('runtime.txt','allowed');for(const p of process.argv.slice(1)){let denied=false;try{fs.readFileSync(p)}catch(e){if(['EPERM','EACCES'].includes(e.code))denied=true;else throw e}if(!denied)process.exit(1)}if(fs.readFileSync('dependency-alias','utf8')!=='FROZEN_DEPENDENCY_CANARY')process.exit(3);let denied=false;try{fs.writeFileSync('dependency-alias','changed')}catch(e){if(['EPERM','EACCES'].includes(e.code))denied=true;else throw e}if(!denied)process.exit(4);if(process.env.npm_config_verify_deps_before_run!=='false'||process.env.npm_config_ignore_scripts!=='true'||process.env.npm_config_offline!=='true')process.exit(2);console.log('POLICY_OK')",
        canary,
        controllerCanary,
      ],
    },
  ];
  const observations: {
    id: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }[] = [];
  let hasCanary = false;
  try {
    await writeFile(canary, 'NON_SECRET_CREDENTIAL_DIRECTORY_CANARY', {
      flag: 'wx',
      mode: 0o600,
    });
    hasCanary = true;
    await symlink(canary, path.join(workspace, 'alias'));
    for (const round of rounds) {
      let result: { stdout: string; stderr: string };
      try {
        result = await execute(
          config.codex.executable,
          [
            'sandbox',
            '-C',
            workspace,
            '-P',
            'limina-eval',
            ...overrides,
            ...round.command,
          ],
          {
            env: {
              HOME: client,
              CODEX_HOME: client,
              TMPDIR: client,
              PATH: [...toolDirectories, '/usr/bin', '/bin'].join(
                path.delimiter,
              ),
              npm_config_verify_deps_before_run: 'false',
              npm_config_ignore_scripts: 'true',
              npm_config_offline: 'true',
            },
            encoding: 'utf8',
            timeout: 15_000,
          },
        );
      } catch (error: unknown) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };
        observations.push({
          ...round,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          exitCode: typeof failure.code === 'number' ? failure.code : null,
        });
        await writeFile(
          path.join(directory, 'native-isolation.json'),
          `${JSON.stringify(observations, null, 2)}\n`,
          { mode: 0o600 },
        );
        throw error;
      }
      if (
        round.id === 'independent-runtime-denial'
          ? !result.stdout.includes('POLICY_OK')
          : !/Operation not permitted|Permission denied/.test(result.stderr)
      )
        throw new Error(`Native sandbox observation incomplete: ${round.id}`);
      observations.push({
        ...round,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      });
      await writeFile(
        path.join(directory, 'native-isolation.json'),
        `${JSON.stringify(observations, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    return observations;
  } finally {
    if (hasCanary) await rm(canary, { force: true });
  }
}

interface DockerIsolationInspection {
  user: string;
  environment: string[];
  host: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Binds: unknown;
    CapDrop: string[];
    SecurityOpt: string[];
  };
  mounts: {
    Type: string;
    Destination: string;
    RW: boolean;
    Driver: string;
  }[];
}

function assertDockerIsolation(
  inspection: DockerIsolationInspection,
  config: FoundationPreflightConfig,
): void {
  if (
    inspection.user !== '1000:1000' ||
    inspection.host.NetworkMode !== 'none' ||
    !inspection.host.ReadonlyRootfs ||
    !inspection.host.CapDrop.includes('ALL') ||
    inspection.host.SecurityOpt.every(
      (value) => !value.startsWith('no-new-privileges'),
    ) ||
    (config.docker.projectDependencies === 'image-volume'
      ? inspection.mounts.length !== 1 ||
        inspection.mounts.some(
          (mount) =>
            mount.Type !== 'volume' ||
            mount.Destination !== '/workspace/node_modules' ||
            mount.RW ||
            mount.Driver !== 'local',
        )
      : inspection.mounts.length > 0) ||
    [
      'npm_config_verify_deps_before_run=false',
      'npm_config_ignore_scripts=true',
      'npm_config_offline=true',
    ].some((entry) => !inspection.environment.includes(entry)) ||
    inspection.environment.some((entry) =>
      /^(?:OPENAI|VERCEL|AI_GATEWAY|CODEX|DOCKER_HOST|.*TOKEN|.*SECRET|.*PASSWORD)=/.test(
        entry,
      ),
    )
  )
    throw new Error(
      'Docker isolation configuration differs from the fixed contract',
    );
}

async function dockerIsolation(
  config: FoundationPreflightConfig,
  directory: string,
  runtimeIdentity: string,
) {
  const fixtureDirectory = path.join(directory, 'verifier-fixture');
  await mkdir(fixtureDirectory);
  await writeFile(
    path.join(fixtureDirectory, 'probe.txt'),
    'controller fixture',
  );
  const fixture = await captureSnapshot(fixtureDirectory, 'F0');
  const task: TaskSpec = {
    version: 2,
    id: 'foundation-probe',
    domain: 'negative-control',
    split: 'dev',
    prompt: 'No Agent; controller capability probe',
    fixtureDigest: fixture.digest!,
    capturePolicy: { excludedRoots: [], requiredRoots: [] },
    mutationPolicy: { rules: [], protectedRoots: [] },
    dependencyPolicy: {
      inputs: [],
      variants: [
        {
          id: 'empty',
          inputsDigest: dependencyInputsIdentity(fixture, []),
          closureDigest: contentIdentity([]),
        },
      ],
    },
    installPlan: {
      toolchainDigest: contentIdentity(config.docker),
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: contentIdentity('foundation-probe'),
      requiredAssertions: ['isolation'],
    },
  };
  const project = await reconstructForVerifier({
    task,
    fixture,
    start: { ...fixture, stage: 'S0' },
    final: { ...fixture, stage: 'S1' },
    destination: path.join(directory, 'reconstructed'),
    prepareStart: async () => {
      /*
      The controller fixture has no setup mutations.
      */
    },
  });
  if (!project.project)
    throw new Error('Controller fixture reconstruction failed');
  const verifier = new DockerVerifier(config.docker);
  try {
    await verifier.start(project.project);
    const inspection =
      (await verifier.inspectIsolation()) as DockerIsolationInspection;
    assertDockerIsolation(inspection, config);
    const observation = await verifier.command('/usr/local/bin/node', [
      '-e',
      "const fs=require('fs'),net=require('net');fs.writeFileSync('writable.txt','ok');let readOnly=false;try{const fd=fs.openSync('/usr/local/bin/pnpm','r+');fs.closeSync(fd)}catch(e){readOnly=['EROFS','EACCES','EPERM'].includes(e.code)}const report={uid:process.getuid(),node:process.version,readOnly,credentials:fs.existsSync('/root/.codex/auth.json'),socket:fs.existsSync('/var/run/docker.sock')};const s=net.connect({host:'198.18.0.1',port:9});s.setTimeout(1000,()=>{s.destroy();console.log(JSON.stringify({...report,network:'timeout'}))});s.once('error',e=>console.log(JSON.stringify({...report,network:e.code})));s.once('connect',()=>{s.destroy();console.log(JSON.stringify({...report,network:'connected'}))});",
    ]);
    const value = JSON.parse(observation.stdout) as {
      uid: number;
      node: string;
      readOnly: boolean;
      credentials: boolean;
      socket: boolean;
      network: string;
    };
    if (
      observation.exitCode !== 0 ||
      value.uid !== 1000 ||
      value.node !== 'v26.13.0' ||
      !value.readOnly ||
      value.credentials ||
      value.socket ||
      value.network !== 'ENETUNREACH'
    )
      throw new Error('Docker runtime isolation probe failed');
    const runtime = await verifier.command('/usr/local/bin/node', [
      '-e',
      "const fs=require('fs'),path=require('path'),crypto=require('crypto'),root='/opt/limina-evals/runtime',entries=[];function visit(relative){const absolute=path.join(root,relative),s=fs.lstatSync(absolute),mode=s.mode&4095;if(s.isSymbolicLink())entries.push({path:relative,kind:'symlink',target:fs.readlinkSync(absolute)});else if(s.isDirectory()){if(relative)entries.push({path:relative,kind:'directory',mode});for(const name of fs.readdirSync(absolute))visit(relative?relative+'/'+name:name)}else if(s.isFile())entries.push({path:relative,kind:'file',mode,sha256:crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')});else throw Error('special dependency file')}visit('');entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));console.log(crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'));",
    ]);
    await writeFile(
      path.join(directory, 'docker-isolation.json'),
      `${JSON.stringify({ inspection, observation, runtime, expectedRuntimeIdentity: runtimeIdentity }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (runtime.exitCode !== 0 || runtime.stdout.trim() !== runtimeIdentity)
      throw new Error('Agent and verifier dependency contents differ');
    if (config.docker.projectDependencies === 'image-volume') {
      // Observe the mounted bytes independently of Docker's mount metadata.
      // Excluding unrelated project files keeps the identity equal to the
      // frozen runtime bundle, which contains the node_modules tree.
      const mounted = await verifier.command('/usr/local/bin/node', [
        '-e',
        runtime.args[1]!.replace(
          "root='/opt/limina-evals/runtime'",
          "root='/workspace'",
        ).replace("visit('');", "visit('node_modules');"),
      ]);
      const protection = await verifier.command('/usr/local/bin/node', [
        '-e',
        "const fs=require('fs');let write=false,rename=false;try{const fd=fs.openSync('/workspace/node_modules/typescript/package.json','r+');fs.closeSync(fd)}catch(e){write=['EROFS','EACCES','EPERM'].includes(e.code)}try{fs.renameSync('/workspace/node_modules','/workspace/replaced')}catch(e){rename=['EBUSY','EROFS','EACCES','EPERM'].includes(e.code)}process.stdout.write(JSON.stringify({write,rename}));",
      ]);
      await writeFile(
        path.join(directory, 'docker-project-dependencies.json'),
        `${JSON.stringify({ mounted, protection, expectedRuntimeIdentity: runtimeIdentity }, null, 2)}\n`,
        { mode: 0o600 },
      );
      if (
        mounted.exitCode !== 0 ||
        mounted.stdout.trim() !== runtimeIdentity ||
        protection.exitCode !== 0 ||
        protection.stdout !== '{"write":true,"rename":true}'
      )
        throw new Error(
          'Project dependency volume is not the protected frozen runtime',
        );
    }
    return { inspection, observation, runtime };
  } finally {
    await verifier.dispose();
  }
}

/**
Read-only account RPCs and local capability probes; never dispatches a model.
*/
export async function foundationPreflight(
  config: FoundationPreflightConfig,
  output: string,
) {
  if (config.version !== 1 || config.scope !== 'foundation')
    throw new Error('Unsupported preflight contract');
  if (
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    (await realpath(path.dirname(output))) !== path.dirname(output) ||
    (await realpath(config.controllerDirectory)) !==
      config.controllerDirectory ||
    !isWithin(config.controllerDirectory, output) ||
    output === config.controllerDirectory
  )
    throw new Error(
      'Preflight evidence must be a new directory in controller storage',
    );
  await mkdir(output, { mode: 0o700 });
  const checks: {
    id: string;
    passed: boolean;
    evidence?: unknown;
    error?: string;
  }[] = [];
  const canPass = async (id: string, action: () => Promise<unknown>) => {
    try {
      checks.push({ id, passed: true, evidence: await action() });
      return true;
    } catch (error) {
      checks.push({
        id,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  const client = path.join(output, 'client-home');
  await mkdir(client);
  const environment = codexEnvironment(
    config.authHome,
    client,
    [path.dirname(config.node.executable)],
    client,
  );
  const isolatedHome = prepareCodexHome(config.authHome, environment);
  try {
    let runtimeIdentity = '';
    const steps: [string, () => Promise<unknown>][] = [
      [
        'isolated-instructions',
        async () => {
          isolatedHome.assertClean();
          return verifyPromptInput(
            config.codex,
            environment,
            output,
            'Inspect the supplied task.',
            [],
            [],
            config.modelProfile,
          );
        },
      ],
      [
        'fixed-toolchain',
        async () => {
          if (
            config.node.version !== '26.13.0' ||
            config.pnpm.version !== '12.10.1'
          )
            throw new Error('Unadmitted Node or pnpm version');
          await verifyBinary(config.node);
          await verifyBinary(config.pnpm);
          await verifyBinary({
            executable: config.docker.executable,
            sha256: config.docker.sha256,
            version: config.docker.version,
          });
          verifyCodex(config.codex, environment);
          if (config.modelProfile)
            verifyPinnedModelCatalog(
              config.codex,
              environment,
              config.modelProfile,
            );
          const nodeVersion = await execute(
            config.node.executable,
            ['--version'],
            { env: environment, cwd: output, timeout: 10_000 },
          );
          const pnpmVersion = await execute(
            config.pnpm.executable,
            ['with', 'current', '--version'],
            { env: environment, cwd: output, timeout: 10_000 },
          );
          const dockerVersion = await execute(
            config.docker.executable,
            ['--version'],
            { env: environment, cwd: output, timeout: 10_000 },
          );
          if (
            nodeVersion.stdout.trim() !== `v${config.node.version}` ||
            pnpmVersion.stdout.trim() !== config.pnpm.version ||
            !dockerVersion.stdout.startsWith(
              `Docker version ${config.docker.version},`,
            )
          )
            throw new Error(
              'Tool version disagrees with frozen binary identity',
            );
          return {
            node: config.node,
            pnpm: config.pnpm,
            codex: config.codex,
            docker: config.docker,
          };
        },
      ],
      [
        'prepared-inputs',
        async () => {
          const prepared = await verifyPreparedInputs(config.preparedDirectory);
          return {
            identity: prepared.identity,
            artifacts: prepared.artifacts,
            skillDigest: prepared.skillDigest,
          };
        },
      ],
      [
        'runtime-bundle',
        async () => {
          const snapshot = await captureSnapshot(
            config.runtimeBundle.directory,
            'F0',
            { maxBytes: 512 * 1024 * 1024, maxEntries: 20_000 },
          );
          if (
            snapshot.status !== 'complete' ||
            snapshot.digest !== config.runtimeBundle.digest
          )
            throw new Error('Runtime dependency bundle identity mismatch');
          for (const entry of snapshot.entries)
            if (
              entry.kind === 'symlink' &&
              (path.isAbsolute(entry.target) ||
                !isWithin(
                  config.runtimeBundle.directory,
                  path.resolve(
                    config.runtimeBundle.directory,
                    path.dirname(entry.path),
                    entry.target,
                  ),
                ))
            )
              throw new Error('Dependency link escapes frozen bundle');
          // Symlink permissions are OS-defined; regular file and directory modes remain binding.
          const portable = snapshot.entries.map((entry) =>
            entry.kind === 'file'
              ? {
                  path: entry.path,
                  kind: entry.kind,
                  mode: entry.mode,
                  sha256: entry.sha256,
                }
              : entry.kind === 'directory'
                ? { path: entry.path, kind: entry.kind, mode: entry.mode }
                : { path: entry.path, kind: entry.kind, target: entry.target },
          );
          runtimeIdentity = sha256(JSON.stringify(portable));
          return { digest: snapshot.digest, portableDigest: runtimeIdentity };
        },
      ],
      ['native-isolation', () => nativeIsolation(config, output)],
      [
        'oauth-model-and-allowance',
        async () => {
          const account = await inspectAccount(
            config.codex,
            environment,
            undefined,
            config.modelProfile,
          );
          if (
            !['plus', 'pro', 'prolite', 'promax'].includes(
              account.auth.planType ?? '',
            ) ||
            account.ordinaryUsageAllowed !== true ||
            account.credits?.balance !== '0' ||
            account.credits.hasCredits ||
            account.credits.unlimited ||
            account.spendControlReached !== false ||
            account.model?.model !==
              (config.modelProfile?.canonicalModelId ?? 'gpt-6.1-terra') ||
            account.model.supportedReasoningEfforts.every(
              (effort) =>
                effort.reasoningEffort !==
                (config.modelProfile?.reasoningEffort ?? 'high'),
            )
          )
            throw new Error(
              'Required OAuth model or included-only allowance unavailable',
            );
          return account;
        },
      ],
      [
        'docker-isolation',
        () => dockerIsolation(config, output, runtimeIdentity),
      ],
      [
        'shared-budget',
        async () => {
          const budget = new BudgetManager(
            path.join(config.controllerDirectory, 'budget.jsonl'),
          ).summary();
          if (
            !budget.includedDispatchReady ||
            budget.remainingAuthorization < budget.reserve
          )
            throw new Error(
              'Budget has unresolved usage or insufficient reserve',
            );
          return {
            currency: budget.currency,
            totalLimit: budget.totalLimit,
            reserve: budget.reserve,
            settledSpend: budget.settledSpend,
            committedSpend: budget.committedSpend,
            remainingBudget: budget.remainingBudget,
            remainingAuthorization: budget.remainingAuthorization,
            financialUnknownRecords: budget.financialUnknownRecords,
          };
        },
      ],
    ];
    for (const [id, action] of steps) if (!(await canPass(id, action))) break;
    const report = {
      version: 1,
      scope: 'foundation',
      observedAt: new Date().toISOString(),
      configurationDigest: contentIdentity(config),
      status:
        checks.length === steps.length && checks.every((entry) => entry.passed)
          ? 'passed'
          : 'blocked',
      formalDispatchAuthorized: false,
      modelCalls: 0,
      checks,
    };
    await writeFile(
      path.join(output, 'preflight.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return report;
  } finally {
    isolatedHome.dispose();
  }
}
