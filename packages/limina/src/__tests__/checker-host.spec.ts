import type { ResolvedLiminaConfig } from '#config/runner';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedDependencyEdge } from '../core/build-graph/runner';
import { createCheckerTaskStats } from '../pipeline/stats';
import { runBuildTargets } from '../typecheck/build/target-execution';
import {
  disposeCheckerProcessHostForTesting,
  resolveCheckerHostEntryForTesting,
  runCheckerHostProtocolProbeForTesting,
} from '../typecheck/process-host';
import { toCheckerTargetOutcome } from '../typecheck/target-types';
import {
  createCheckerTargetId,
  createDefaultRunner,
  type TypecheckRunnerResult,
  type TypecheckTarget,
} from '../typecheck/targets';
import { withFixtureGovernanceRoot } from './helpers/governance-root';

function createSleepTarget(sleepMs: number, name: string): TypecheckTarget {
  return {
    args: ['-e', `setTimeout(() => process.exit(0), ${sleepMs});`],
    command: process.execPath,
    configPath: `/virtual/${name}/tsconfig.json`,
    cwd: process.cwd(),
    id: createCheckerTargetId(['test', name]),
  };
}

function createPoolConfig(): ResolvedLiminaConfig {
  return withFixtureGovernanceRoot({
    configPath: '/virtual/limina.config.mjs',
    rootDir: '/virtual',
    concurrency: { checkerBuild: 2 },
  });
}

function blockMainThread(durationMs: number): void {
  const blocker = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );

  // Block this event loop without burning a CPU core, so the checker host and
  // its child processes remain schedulable on constrained CI runners.
  Atomics.wait(blocker, 0, 0, durationMs);
}

async function waitForMacrotasks(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filePath)) return;
    await waitForMacrotasks(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      String(error.code) === 'ESRCH'
    );
  }
}

function isProcessExecuting(pid: number): boolean {
  // A blocked parent cannot reap an exited child; zombies are exited, not running.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (state.error !== undefined) throw state.error;
  return state.status === 0 && !state.stdout.trimStart().startsWith('Z');
}

afterEach(async () => {
  delete process.env.LIMINA_CHECKER_HOST;
  await disposeCheckerProcessHostForTesting();
});

describe('createDefaultRunner duration measurement', () => {
  it('executes the package sibling host bundle instead of consumer cwd candidates', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'limina-host-authority-'),
    );
    const packageDirectory = path.join(rootDirectory, 'node_modules/limina');
    const consumerDirectory = path.join(rootDirectory, 'consumer');
    const safeMarker = path.join(rootDirectory, 'safe-marker');
    const unsafeMarker = path.join(rootDirectory, 'unsafe-marker');

    try {
      await mkdir(path.join(packageDirectory, 'dist/typecheck'), {
        recursive: true,
      });
      await mkdir(path.join(consumerDirectory, 'src/typecheck'), {
        recursive: true,
      });
      await mkdir(path.join(consumerDirectory, 'dist'), { recursive: true });
      await writeFile(
        path.join(packageDirectory, 'dist/checker-host-process.js'),
        "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SAFE_MARKER, 'safe');\n",
      );
      const unsafeSource =
        "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.UNSAFE_MARKER, 'unsafe');\n";

      await writeFile(
        path.join(consumerDirectory, 'src/typecheck/host-process.ts'),
        unsafeSource,
      );
      await writeFile(
        path.join(consumerDirectory, 'dist/checker-host-process.js'),
        unsafeSource,
      );

      const entry = resolveCheckerHostEntryForTesting(
        pathToFileURL(
          path.join(packageDirectory, 'dist/typecheck/process-host.js'),
        ).href,
      );

      expect(entry).toBeDefined();
      const result = spawnSync(entry!.command, entry!.args, {
        cwd: consumerDirectory,
        env: {
          ...process.env,
          SAFE_MARKER: safeMarker,
          UNSAFE_MARKER: unsafeMarker,
        },
      });

      expect(result.status).toBe(0);
      await expect(readFile(safeMarker, 'utf8')).resolves.toBe('safe');
      expect(existsSync(unsafeMarker)).toBe(false);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'separates independent command timing from the full blocked-main lifetime',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'limina-host-timing-'));
      const release = path.join(root, 'release');
      const runner = createDefaultRunner({ stdio: 'ignore' });
      const target = (name: string, sleepMs: number): TypecheckTarget => ({
        ...createSleepTarget(sleepMs, name),
        args: [
          '-e',
          `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(root, name))}, 'started'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); setTimeout(() => {}, ${sleepMs}); } }, 5);`,
        ],
      });
      try {
        const short = Promise.resolve(runner(target('short', 150)));
        const long = Promise.resolve(runner(target('long', 600)));
        await Promise.all(
          ['short', 'long'].map((name) => waitForFile(path.join(root, name))),
        );
        await writeFile(release, 'go');
        blockMainThread(1500);
        const [shortResult, longResult] = await Promise.all([short, long]);
        expect(shortResult.status).toBe(0);
        expect(longResult.status).toBe(0);
        expect(
          longResult.commandDurationMs! - shortResult.commandDurationMs!,
        ).toBeGreaterThan(225);
        expect(shortResult.durationMs).toBeGreaterThanOrEqual(1500);
        expect(longResult.durationMs).toBeGreaterThanOrEqual(1500);
        expect(shortResult.durationMs!).toBeGreaterThan(
          shortResult.commandDurationMs!,
        );
      } finally {
        await disposeCheckerProcessHostForTesting();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([undefined, 'off'])(
    'preserves inherited stdin with host mode %s',
    (hostMode) => {
      const source = new URL('../typecheck/process-host.ts', import.meta.url)
        .href;
      const loader = pathToFileURL(
        createRequire(import.meta.url).resolve('tsx'),
      ).href;
      const command =
        "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ input: fs.readFileSync(0, 'utf8'), arg: process.argv[1], token: process.env.STDIN_TOKEN })); process.stderr.write('checker-stderr'); process.exit(7);";
      const driver = `const { runCheckerSpawnMeasured } = await import(${JSON.stringify(source)}); const result = await runCheckerSpawnMeasured({command:process.execPath,args:['-e',${JSON.stringify(command)},'two words'],cwd:process.cwd(),env:process.env,shell:false,stdio:'inherit'}); process.exitCode=result.status;`;
      const result = spawnSync(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', driver],
        {
          encoding: 'utf8',
          input: 'exact stdin\n',
          env: {
            ...process.env,
            LIMINA_CHECKER_HOST: hostMode,
            STDIN_TOKEN: 'preserved',
          },
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(7);
      expect(JSON.parse(result.stdout)).toEqual({
        input: 'exact stdin\n',
        arg: 'two words',
        token: 'preserved',
      });
      expect(result.stderr).toBe('checker-stderr');
    },
  );

  it('propagates spawn errors with a measured duration', async () => {
    const runner = createDefaultRunner({ stdio: 'ignore' });

    const result = await runner({
      args: [],
      command: path.join(process.cwd(), 'limina-missing-command-xyz'),
      configPath: '/virtual/missing/tsconfig.json',
      cwd: process.cwd(),
      id: createCheckerTargetId(['test', 'missing']),
    });

    expect(result.status).toBe(1);
    expect(result.error?.message).toContain('ENOENT');
    expect(result.durationMs).toBeDefined();
  });

  it('cancels an active checker child through its owned supervisor', async () => {
    const controller = new AbortController();
    const runner = createDefaultRunner({ stdio: 'ignore' });
    const startedAt = performance.now();
    const resultPromise = Promise.resolve(
      runner(createSleepTarget(5000, 'cancelled'), {
        signal: controller.signal,
      }),
    );

    await waitForMacrotasks(100);
    controller.abort(new Error('cancel checker target'));
    const result = await resultPromise;

    expect(result.status).toBe(1);
    expect(result.error?.message).toBe('cancel checker target');
    expect(performance.now() - startedAt).toBeLessThan(3000);
  });

  it('waits for a stubborn checker process tree to exit before resolving cancellation', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'limina-host-cancellation-'),
    );
    const pidPath = path.join(rootDirectory, 'checker.pid');

    try {
      const controller = new AbortController();
      const runner = createDefaultRunner({ stdio: 'ignore' });
      const target: TypecheckTarget = {
        args: [
          '-e',
          [
            `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
            "process.on('SIGTERM', () => undefined);",
            'setInterval(() => undefined, 1000);',
          ].join(''),
        ],
        command: process.execPath,
        configPath: '/virtual/stubborn/tsconfig.json',
        cwd: process.cwd(),
        id: createCheckerTargetId(['test', 'stubborn']),
      };
      const resultPromise = Promise.resolve(
        runner(target, { signal: controller.signal }),
      );
      await waitForFile(pidPath);
      const pid = Number(await readFile(pidPath, 'utf8'));

      controller.abort(new Error('cancel stubborn checker'));
      const result = await resultPromise;

      expect(result.error?.message).toBe('cancel stubborn checker');
      expect(result.status).toBe(1);
      expect(isProcessRunning(pid)).toBe(false);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it('runs inline with a single degradation notice when LIMINA_CHECKER_HOST=off', async () => {
    process.env.LIMINA_CHECKER_HOST = 'off';

    const onDegraded = vi.fn();
    const runner = createDefaultRunner({ onDegraded, stdio: 'ignore' });

    const firstResult = await runner(createSleepTarget(60, 'off-first'));
    const secondResult = await runner(createSleepTarget(60, 'off-second'));

    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(firstResult.durationMs).toBeGreaterThan(0);
    expect(secondResult.durationMs).toBeGreaterThan(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it
    .skipIf(process.platform === 'win32')
    .each(['existing', 'once', 'dynamic', 'prepend-once'])(
    'defers native signal ownership to a %s custom handler',
    async (mode) => {
      const root = await mkdtemp(path.join(tmpdir(), 'limina-custom-signal-'));
      const pidPath = path.join(root, 'pid');
      const readyPath = path.join(root, 'ready');
      const handledPath = path.join(root, 'handled');
      const finishPath = path.join(root, 'finish');
      const source = new URL('../typecheck/process-host.ts', import.meta.url)
        .href;
      const loader = pathToFileURL(
        createRequire(import.meta.url).resolve('tsx'),
      ).href;
      const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`;
      const registration =
        mode === 'prepend-once'
          ? 'prependOnceListener'
          : mode === 'once'
            ? 'once'
            : 'on';
      const register = `process.${registration}('SIGTERM',custom);`;
      const driver = `const fs=await import('node:fs');const{setTimeout:delay}=await import('node:timers/promises');const { runCheckerSpawnMeasured } = await import(${JSON.stringify(source)});const custom=()=>fs.writeFileSync(${JSON.stringify(handledPath)},'handled');${mode === 'existing' || mode === 'once' ? register : ''}const controller=new AbortController();const pending=runCheckerSpawnMeasured({command:process.execPath,args:['-e',${JSON.stringify(childCode)}],cwd:process.cwd(),env:process.env,shell:false,stdio:'ignore'},{signal:controller.signal});while(!fs.existsSync(${JSON.stringify(pidPath)}))await delay(5);${mode === 'dynamic' || mode === 'prepend-once' ? register : ''}fs.writeFileSync(${JSON.stringify(readyPath)},'ready');while(!fs.existsSync(${JSON.stringify(finishPath)}))await delay(5);controller.abort();await pending;process.removeListener('SIGTERM',custom);`;
      const parent = spawn(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', driver],
        { stdio: 'ignore' },
      );
      const closed = new Promise<void>((resolve) =>
        parent.once('close', () => resolve()),
      );
      let pid: number | undefined;
      try {
        await waitForFile(readyPath);
        pid = Number(await readFile(pidPath, 'utf8'));
        parent.kill('SIGTERM');
        await waitForFile(handledPath);
        expect(parent.exitCode).toBeNull();
        expect(parent.signalCode).toBeNull();
        expect(isProcessRunning(pid)).toBe(true);
        if (mode === 'once' || mode === 'prepend-once') parent.kill('SIGTERM');
        else await writeFile(finishPath, 'finish');
        await closed;
        if (mode === 'once' || mode === 'prepend-once')
          expect(parent.signalCode).toBe('SIGTERM');
        else expect(parent.exitCode).toBe(0);
        for (
          let attempt = 0;
          attempt < 100 && isProcessRunning(pid);
          attempt += 1
        )
          await waitForMacrotasks(20);
        expect(isProcessRunning(pid)).toBe(false);
      } finally {
        if (parent.exitCode === null && parent.signalCode === null)
          parent.kill('SIGKILL');
        await closed;
        if (pid !== undefined && isProcessRunning(pid))
          process.kill(pid, 'SIGKILL');
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['inflight', undefined, 'exit'],
    ['after-result', undefined, 'exit'],
    ['inflight', 'off', 'exit'],
    ['after-result', 'off', 'exit'],
    ['after-result', undefined, 'SIGTERM'],
    ['after-result', undefined, 'SIGINT'],
    ['after-result', 'off', 'SIGTERM'],
  ])(
    'cleans its known group on main shutdown %s with host mode %s via %s',
    async (mode, hostMode, shutdown) => {
      const root = await mkdtemp(path.join(tmpdir(), 'limina-main-exit-'));
      const descendantMarker = path.join(root, 'descendant');
      const groupMarker = path.join(root, 'group');
      const blockedMarker = path.join(root, 'blocked');
      const commandRelease = path.join(root, 'command-release');
      const exitRelease = path.join(root, 'exit-release');
      const source = new URL('../typecheck/process-host.ts', import.meta.url)
        .href;
      const loader = pathToFileURL(
        createRequire(import.meta.url).resolve('tsx'),
      ).href;
      const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)},String(process.pid));setInterval(()=>{},1000);`;
      const command = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(groupMarker)},JSON.stringify({pid:process.pid,host:process.ppid}));setInterval(()=>{if(${JSON.stringify(mode)}==='after-result'&&fs.existsSync(${JSON.stringify(commandRelease)}))process.exit(0);},5);`;
      const driver = `const fs=await import('node:fs');const{setTimeout:delay}=await import('node:timers/promises');const { runCheckerSpawnMeasured } = await import(${JSON.stringify(source)});runCheckerSpawnMeasured({command:process.execPath,args:['-e',${JSON.stringify(command)}],cwd:process.cwd(),env:process.env,shell:false,stdio:'ignore'});while(!fs.existsSync(${JSON.stringify(descendantMarker)}))await delay(5);fs.writeFileSync(${JSON.stringify(blockedMarker)},'ready');while(!fs.existsSync(${JSON.stringify(exitRelease)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);${shutdown === 'exit' ? 'process.exit(0);' : 'setInterval(()=>{},1000);'}`;
      const parent = spawn(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', driver],
        {
          stdio: 'ignore',
          env: { ...process.env, LIMINA_CHECKER_HOST: hostMode },
        },
      );
      const closed = new Promise<void>((resolve) =>
        parent.once('close', () => resolve()),
      );
      let group: { pid: number; host: number } | undefined;
      try {
        await waitForFile(blockedMarker);
        group = JSON.parse(await readFile(groupMarker, 'utf8')) as typeof group;
        const descendantPid = Number(await readFile(descendantMarker, 'utf8'));
        if (mode === 'after-result') {
          await writeFile(commandRelease, 'go');
          const completedLeader = hostMode === 'off' ? group!.pid : group!.host;
          for (
            let attempt = 0;
            attempt < 100 && isProcessExecuting(completedLeader);
            attempt += 1
          )
            await waitForMacrotasks(20);
          expect(isProcessExecuting(completedLeader)).toBe(false);
          expect(isProcessRunning(descendantPid)).toBe(true);
        }
        if (shutdown !== 'exit') parent.kill(shutdown as 'SIGINT' | 'SIGTERM');
        await writeFile(exitRelease, 'exit');
        await closed;
        if (shutdown === 'exit') expect(parent.exitCode).toBe(0);
        else expect(parent.signalCode).toBe(shutdown);
        for (
          let attempt = 0;
          attempt < 100 && isProcessRunning(descendantPid);
          attempt += 1
        )
          await waitForMacrotasks(20);
        expect(isProcessRunning(descendantPid)).toBe(false);
        expect(isProcessRunning(group!.pid)).toBe(false);
      } finally {
        if (parent.exitCode === null) parent.kill('SIGKILL');
        await closed;
        if (group !== undefined) {
          try {
            process.kill(
              -(hostMode === 'off' ? group.pid : group.host),
              'SIGKILL',
            );
          } catch {
            /*
            already exited
            */
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each(['running', 'completed', 'cancelled'])(
    'never replays effects after losing a %s command supervisor',
    async (mode) => {
      const root = await mkdtemp(path.join(tmpdir(), 'limina-host-loss-'));
      const marker = path.join(root, 'ledger');
      const controller = new AbortController();
      let pids: { pid: number; host: number } | undefined;
      try {
        const runner = createDefaultRunner({ stdio: 'ignore' });
        const pending = Promise.resolve(
          runner(
            {
              ...createSleepTarget(0, mode),
              args: [
                '-e',
                `const fs = require('node:fs'); process.on('SIGTERM', () => {}); process.kill(process.ppid, 'SIGSTOP'); fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, host: process.ppid }) + '\\n'); ${mode === 'completed' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`,
              ],
            },
            { signal: controller.signal },
          ),
        );
        await waitForFile(marker);
        pids = JSON.parse(
          (await readFile(marker, 'utf8')).trim(),
        ) as typeof pids;
        if (mode === 'cancelled')
          controller.abort(new Error('cancel lost supervisor'));
        process.kill(pids!.host, 'SIGKILL');
        const result = await pending;
        expect(result.status).toBe(1);
        expect(result.commandDurationMs).toBeUndefined();
        expect(result.durationMs).toBeGreaterThan(0);
        if (mode === 'cancelled')
          expect(result.error?.message).toBe('cancel lost supervisor');
        expect(
          (await readFile(marker, 'utf8')).trim().split('\n'),
        ).toHaveLength(1);
        expect(isProcessRunning(pids!.pid)).toBe(false);
        expect(isProcessRunning(pids!.host)).toBe(false);
      } finally {
        await disposeCheckerProcessHostForTesting();
        if (pids !== undefined) {
          try {
            process.kill(-pids.host, 'SIGKILL');
          } catch {
            /*
            already gone
            */
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'falls back only before dispatch and retains the failed setup interval',
    async () => {
      const onDegraded = vi.fn();
      const result = await runCheckerHostProtocolProbeForTesting({
        entry: {
          command: process.execPath,
          args: [
            '-e',
            "setTimeout(() => process.send('invalid'), 80); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
          ],
        },
        onDegraded,
        spec: {
          command: process.execPath,
          args: ['-e', 'process.exit(7)'],
          cwd: process.cwd(),
          env: process.env,
          shell: false,
          stdio: 'ignore',
        },
      });
      expect(result.status).toBe(7);
      expect(result.commandDurationMs).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(580);
      expect(onDegraded).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails without replay after a malformed post-dispatch response',
    async () => {
      const onDegraded = vi.fn();
      const result = await runCheckerHostProtocolProbeForTesting({
        entry: {
          command: process.execPath,
          args: [
            '-e',
            "process.on('message', () => process.send('invalid')); process.send({ type: 'ready' });",
          ],
        },
        onDegraded,
        spec: {
          command: process.execPath,
          args: ['-e', 'process.exit(7)'],
          cwd: process.cwd(),
          env: process.env,
          shell: false,
          stdio: 'ignore',
        },
      });
      expect(result.status).toBe(1);
      expect(result.error?.message).toContain('invalid protocol');
      expect(result.commandDurationMs).toBeUndefined();
      expect(onDegraded).not.toHaveBeenCalled();
    },
  );
});

describe('runBuildTargets duration reporting', () => {
  it('prefers runner-reported durationMs over the pool wall-clock measurement', async () => {
    const target = createSleepTarget(0, 'reported');
    const runner = async (): Promise<TypecheckRunnerResult> => {
      await waitForMacrotasks(40);

      return {
        configPath: target.configPath,
        durationMs: 123,
        commandDurationMs: 45,
        status: 0,
      };
    };

    const results = await runBuildTargets([target], [], runner, {
      config: createPoolConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      durationMs: 123,
      commandDurationMs: 45,
      status: 0,
    });
    const result = results[0]!;
    if (typeof result.status !== 'number')
      throw new Error('Target did not execute.');
    expect(toCheckerTargetOutcome(target, result)).toMatchObject({
      durationMs: 123,
      commandDurationMs: 45,
      status: 'passed',
    });
    const stats = createCheckerTaskStats({
      targetResults: [result],
      rootConfigPaths: [target.configPath],
      projectRootDir: '/virtual',
      failedTargets: [],
      passed: true,
    });
    expect(stats.items).toEqual([
      expect.objectContaining({
        itemKind: 'checker-target',
        durationMs: 123,
        commandDurationMs: 45,
      }),
    ]);
  });

  it('falls back to pool wall-clock measurement when the runner reports no duration', async () => {
    const target = createSleepTarget(0, 'unreported');
    const runner = async (): Promise<TypecheckRunnerResult> => {
      await waitForMacrotasks(40);

      return {
        configPath: target.configPath,
        status: 0,
      };
    };

    const results = await runBuildTargets([target], [], runner, {
      config: createPoolConfig(),
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (typeof result.status !== 'number')
      throw new Error('Checker did not execute.');
    expect(result.durationMs).toBeGreaterThanOrEqual(35);
  });
});

describe('runBuildTargets provider blocking', () => {
  function createBuildTarget(name: string): TypecheckTarget {
    return {
      ...createSleepTarget(0, name),
      checkerName: name,
      sourceConfigPath: `/virtual/${name}/source.json`,
    };
  }

  function edge(from: string, to: string): GeneratedDependencyEdge {
    return {
      cacheReuse: 'non-reusable',
      file: `/virtual/${from}/src.ts`,
      fromChecker: from,
      fromConfigPath: `/virtual/${from}/source.json`,
      importedSpecifier: to,
      kind: 'declaration-provider',
      resolvedFilePath: `/virtual/${to}/dist.d.ts`,
      toChecker: to,
      toConfigPath: `/virtual/${to}/source.json`,
    };
  }

  function schedulingEdge(from: string, to: string): GeneratedDependencyEdge {
    const declarationEdge = edge(from, to);
    return {
      file: declarationEdge.file,
      fromChecker: declarationEdge.fromChecker,
      fromConfigPath: declarationEdge.fromConfigPath,
      importedSpecifier: declarationEdge.importedSpecifier,
      kind: 'framework-schedule',
      resolvedFilePath: declarationEdge.resolvedFilePath,
      toChecker: declarationEdge.toChecker,
      toConfigPath: declarationEdge.toConfigPath,
    };
  }

  it('does not turn a source schedule or declaration ordering edge into a process prerequisite', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    for (const relation of [
      edge('consumer', 'provider'),
      schedulingEdge('consumer', 'provider'),
    ]) {
      const calls: string[] = [];
      const results = await runBuildTargets(
        [consumer, provider],
        [relation],
        async (target) => {
          calls.push(target.id);
          return {
            configPath: target.configPath,
            status: target.id === provider.id ? 1 : 0,
          };
        },
        { config: createPoolConfig() },
      );
      expect(calls).toEqual([provider.id, consumer.id]);
      expect(results.find((item) => item.id === consumer.id)).toMatchObject({
        status: 0,
      });
    }
  });

  it('does not inherit a failed schedule sibling through a successful hard prerequisite', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const results = await runBuildTargets(
      [first, second, consumer],
      [
        schedulingEdge('first', 'second'),
        schedulingEdge('second', 'first'),
        edge('consumer', 'first'),
      ],
      async (target) => ({
        configPath: target.configPath,
        status: target.id === second.id ? 1 : 0,
      }),
      {
        config: createPoolConfig(),
        executionPrerequisites: [edge('consumer', 'first')],
      },
    );
    expect(results.find((item) => item.id === consumer.id)).toMatchObject({
      status: 0,
    });
  });

  it('blocks direct and transitive consumers by root provider id', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    const transitive = createBuildTarget('transitive');
    const unrelated = createBuildTarget('unrelated');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [transitive, consumer, provider, unrelated],
      [edge('consumer', 'provider'), edge('transitive', 'consumer')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === provider.id ? 1 : 0,
        };
      },
      {
        config: createPoolConfig(),
        executionPrerequisites: [
          edge('consumer', 'provider'),
          edge('transitive', 'consumer'),
        ],
      },
    );

    expect(calls).toContain(provider.id);
    expect(calls).toContain(unrelated.id);
    expect(calls).not.toContain(consumer.id);
    expect(calls).not.toContain(transitive.id);
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      status: 'blocked',
      blockedBy: [provider.id],
    });
    expect(results.find((result) => result.id === transitive.id)).toMatchObject(
      { status: 'blocked', blockedBy: [provider.id] },
    );
  });

  it('does not add provider completion gating in watch mode', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    const calls: string[] = [];
    await runBuildTargets(
      [consumer, provider],
      [edge('consumer', 'provider')],
      async (target) => {
        calls.push(target.id);
        return { configPath: target.configPath, status: 0 };
      },
      { config: createPoolConfig(), watch: true },
    );

    expect(
      calls.sort((left, right) => Number(left > right) - Number(left < right)),
    ).toEqual(
      [consumer.id, provider.id].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    );
  });

  it('does not cancel targets that execute inside the same provider SCC', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [first, second],
      [schedulingEdge('first', 'second'), schedulingEdge('second', 'first')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id ? 1 : 0,
        };
      },
      { config: createPoolConfig() },
    );

    expect(
      calls.sort((left, right) => Number(left > right) - Number(left < right)),
    ).toEqual(
      [first.id, second.id].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    );
    const secondResult = results.find((result) => result.id === second.id);
    expect(secondResult).toMatchObject({ status: 0 });
    expect(secondResult).not.toHaveProperty('blockedBy');
  });

  it('settles every runnable SCC member with concurrency one after a sibling fails', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const calls: string[] = [];
    const config = createPoolConfig();
    config.concurrency = { checkerBuild: 1 };

    await runBuildTargets(
      [first, second],
      [schedulingEdge('first', 'second'), schedulingEdge('second', 'first')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id ? 1 : 0,
        };
      },
      { config },
    );

    expect(calls).toEqual([first.id, second.id]);
  });

  it('propagates every real SCC failure root in stable target plan order', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const results = await runBuildTargets(
      [first, second, consumer],
      [
        schedulingEdge('first', 'second'),
        schedulingEdge('second', 'first'),
        edge('consumer', 'first'),
      ],
      async (target) => ({
        configPath: target.configPath,
        status: target.id === consumer.id ? 0 : 1,
      }),
      {
        config: createPoolConfig(),
        executionPrerequisites: [
          edge('consumer', 'first'),
          edge('consumer', 'second'),
        ],
      },
    );

    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id, second.id],
      status: 'blocked',
    });
  });

  it('blocks downstream on failed SCC members while retaining passed siblings', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const results = await runBuildTargets(
      [first, second, consumer],
      [
        schedulingEdge('first', 'second'),
        schedulingEdge('second', 'first'),
        edge('consumer', 'first'),
      ],
      async (target) => ({
        configPath: target.configPath,
        status: target.id === first.id ? 1 : 0,
      }),
      {
        config: createPoolConfig(),
        executionPrerequisites: [edge('consumer', 'first')],
      },
    );

    expect(results.find((result) => result.id === second.id)).toMatchObject({
      status: 0,
    });
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id],
    });
  });

  it('merges all failed upstream components and keeps unrelated work runnable', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const unrelated = createBuildTarget('unrelated');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [first, second, consumer, unrelated],
      [edge('consumer', 'first'), edge('consumer', 'second')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id || target.id === second.id ? 1 : 0,
        };
      },
      {
        config: createPoolConfig(),
        executionPrerequisites: [
          edge('consumer', 'first'),
          edge('consumer', 'second'),
        ],
      },
    );

    expect(calls).toContain(unrelated.id);
    expect(calls).not.toContain(consumer.id);
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id, second.id],
    });
  });

  it('keeps completed process results and propagates only explicit prerequisite refusals', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    const transitive = createBuildTarget('transitive');
    const calls: string[] = [];
    const started: string[] = [];
    const results = await runBuildTargets(
      [provider, consumer, transitive],
      [edge('consumer', 'provider'), edge('transitive', 'consumer')],
      async (target) => {
        calls.push(target.id);
        return { configPath: target.configPath, status: 0 };
      },
      {
        executeTarget: async (target) => {
          if (target.id === consumer.id)
            return {
              status: 'admission-rejected',
              id: target.id,
              stage: 'mutation',
              decision: 'unavailable',
              diagnostics: [
                {
                  code: 'LIMINA_EXECUTION_INPUT_UNAVAILABLE',
                  message: 'input changed',
                },
              ],
            };
          calls.push(target.id);
          return {
            id: target.id,
            configPath: target.configPath,
            status: 0,
            durationMs: 0,
          };
        },
        executionPrerequisites: [
          edge('consumer', 'provider'),
          edge('transitive', 'consumer'),
        ],
        config: createPoolConfig(),
        onTargetStart: (target) => {
          started.push(target.id);
        },
      },
    );

    expect(calls).toEqual([provider.id]);
    expect(started).toEqual([provider.id, consumer.id]);
    expect(results.find((result) => result.id === provider.id)).toMatchObject({
      status: 0,
    });
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      status: 'admission-rejected',
    });
    expect(results.find((result) => result.id === transitive.id)).toMatchObject(
      {
        blockedBy: [consumer.id],
        status: 'blocked',
      },
    );
  });
});
