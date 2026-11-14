import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnAndMeasure } from '../typecheck/host-protocol';
import {
  disposeCheckerProcessHostForTesting,
  runCheckerSpawnMeasured,
} from '../typecheck/process-host';
import {
  terminateChildProcessTree,
  waitForChildProcessTreeTermination,
} from '../typecheck/process-tree';
import { createFixturePathResolver } from './helpers/path';

async function createGroupFixture(
  leaderMode: string,
  childMode: string,
  exitCode = 0,
) {
  const rootDirectory = await mkdtemp(
    path.join(tmpdir(), 'limina-process-tree-'),
  );
  const fixturePath = createFixturePathResolver(rootDirectory);
  const childScript = [
    "const fs = require('node:fs');",
    childMode === 'stubborn'
      ? `process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(fixturePath('termination-started'))}, 'signal'));`
      : '',
    childMode === 'delayed'
      ? "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 180));"
      : '',
    `fs.writeFileSync(${JSON.stringify(fixturePath('child.pid'))}, String(process.pid));`,
    'setTimeout(() => process.exit(0), 15000);',
  ].join('\n');
  const script = [
    "const fs = require('node:fs');",
    `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'});`,
    'child.unref();',
    leaderMode === 'stubborn' ? "process.on('SIGTERM', () => {});" : '',
    `const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(fixturePath('child.pid'))})) return; clearInterval(timer); fs.writeFileSync(${JSON.stringify(fixturePath('ready.json'))}, JSON.stringify({pid:process.pid, child:child.pid})); ${leaderMode === 'early' ? `process.exit(${exitCode});` : ''} }, 10);`,
    'setTimeout(() => process.exit(0), 15000);',
  ].join('\n');
  await mkdir(rootDirectory, { recursive: true });
  await writeFile(fixturePath('leader.cjs'), script);
  return { rootDir: rootDirectory, path: fixturePath };
}

async function waitForReady(
  file: string,
): Promise<{ pid: number; child: number }> {
  for (let index = 0; index < 150; index += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      await delay(20);
    }
  }
  throw new Error('Process group fixture did not become ready.');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /*
    The owned group already exited.
    */
  }
}

afterEach(() => disposeCheckerProcessHostForTesting());

describe.skipIf(process.platform === 'win32')(
  'POSIX checker process groups',
  () => {
    it.each([
      ['direct', 'early'],
      ['direct', 'stubborn'],
      ['host', 'early'],
    ])(
      'still escalates after a blocked parent: %s %s',
      async (entry, leaderMode) => {
        const fixture = await createGroupFixture(leaderMode, 'stubborn', 7);
        const controller = new AbortController();
        let group: { pid: number; child: number } | undefined;
        const spec = {
          command: process.execPath,
          args: [fixture.path('leader.cjs')],
          cwd: fixture.rootDir,
          env: process.env,
          shell: false,
          stdio: 'ignore' as const,
        };
        try {
          const pending =
            entry === 'host'
              ? runCheckerSpawnMeasured(spec, { signal: controller.signal })
              : spawnAndMeasure(spec, { signal: controller.signal });
          group = await waitForReady(fixture.path('ready.json'));
          if (leaderMode === 'stubborn')
            controller.abort(new Error('cancel blocked parent'));
          for (
            let attempt = 0;
            attempt < 100 && !existsSync(fixture.path('termination-started'));
            attempt += 1
          )
            await delay(10);
          expect(existsSync(fixture.path('termination-started'))).toBe(true);
          expect(isAlive(group.child)).toBe(true);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2300);
          const result = await pending;
          expect(result.status).toBe(leaderMode === 'early' ? 7 : 1);
          if (leaderMode === 'early') expect(result.error).toBeUndefined();
          else expect(result.error?.message).toBe('cancel blocked parent');
          expect(result.durationMs).toBeGreaterThanOrEqual(2300);
          expect(isAlive(group.child)).toBe(false);
          expect(isAlive(group.pid)).toBe(false);
        } finally {
          await disposeCheckerProcessHostForTesting();
          cleanGroup(group?.pid);
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ['direct', 'responsive', 0],
      ['direct', 'stubborn', 7],
      ['direct', 'delayed', 7],
      ['host', 'stubborn', 0],
      ['host', 'responsive', 7],
    ] as const)(
      'cleans descendants before natural completion: %s %s %i',
      async (entry, childMode, status) => {
        const fixture = await createGroupFixture('early', childMode, status);
        let group: { pid: number; child: number } | undefined;
        try {
          const spec = {
            command: process.execPath,
            args: [fixture.path('leader.cjs')],
            cwd: fixture.rootDir,
            env: process.env,
            shell: false,
            stdio: 'ignore' as const,
          };
          const onDegraded = vi.fn();
          const pending =
            entry === 'direct'
              ? spawnAndMeasure(spec)
              : runCheckerSpawnMeasured(spec, { onDegraded });
          group = await waitForReady(fixture.path('ready.json'));
          const result = await pending;
          expect(result).toMatchObject({ status });
          expect(result.error).toBeUndefined();
          expect(isAlive(group.child)).toBe(false);
          expect(isAlive(group.pid)).toBe(false);
          expect(onDegraded).not.toHaveBeenCalled();
          if (childMode === 'stubborn')
            expect(result.durationMs).toBeGreaterThanOrEqual(450);
          else if (childMode === 'delayed')
            expect(result.durationMs).toBeGreaterThanOrEqual(180);
        } finally {
          cleanGroup(group?.pid);
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ['direct', 'responsive'],
      ['direct', 'stubborn'],
      ['host', 'stubborn'],
    ] as const)(
      'measures active cancellation through cleanup: %s %s',
      async (entry, mode) => {
        const fixture = await createGroupFixture(mode, mode);
        const controller = new AbortController();
        const reason = new Error('cancel running checker');
        const onDegraded = vi.fn();
        let group: { pid: number; child: number } | undefined;
        try {
          const runner =
            entry === 'direct' ? spawnAndMeasure : runCheckerSpawnMeasured;
          const pending = runner(
            {
              command: process.execPath,
              args: [fixture.path('leader.cjs')],
              cwd: fixture.rootDir,
              env: process.env,
              shell: false,
              stdio: 'ignore',
            },
            { signal: controller.signal, onDegraded },
          );
          group = await waitForReady(fixture.path('ready.json'));
          await delay(80);
          controller.abort(reason);
          const result = await pending;
          expect(result.status).toBe(1);
          expect(result.error).toBe(reason);
          expect(isAlive(group.pid)).toBe(false);
          expect(isAlive(group.child)).toBe(false);
          expect(onDegraded).not.toHaveBeenCalled();
          expect(result.durationMs).toBeGreaterThanOrEqual(
            mode === 'stubborn' ? 450 : 70,
          );
        } finally {
          cleanGroup(group?.pid);
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );

    it.each(['direct', 'host'] as const)(
      'keeps cancellation before spawn unmeasured: %s',
      async (entry) => {
        const fixture = await createGroupFixture('responsive', 'responsive');
        try {
          const controller = new AbortController();
          const reason = new Error('cancel before launch');
          controller.abort(reason);
          const runner =
            entry === 'direct' ? spawnAndMeasure : runCheckerSpawnMeasured;
          const result = await runner(
            {
              command: process.execPath,
              args: [fixture.path('leader.cjs')],
              cwd: fixture.rootDir,
              env: process.env,
              shell: false,
              stdio: 'ignore',
            },
            { signal: controller.signal },
          );
          expect(result).toEqual({ durationMs: 0, status: 1, error: reason });
          await expect(
            readFile(fixture.path('ready.json')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ['stubborn', 'stubborn'],
      ['early', 'stubborn'],
      ['early', 'delayed'],
    ])(
      'finishes owned cleanup across a forward wall-clock jump: %s %s',
      async (leaderMode, childMode) => {
        const fixture = await createGroupFixture(leaderMode, childMode);
        const child = spawn(process.execPath, [fixture.path('leader.cjs')], {
          cwd: fixture.rootDir,
          detached: true,
          stdio: 'ignore',
        });
        let group: { pid: number; child: number } | undefined;
        const originalNow = Date.now;
        try {
          group = await waitForReady(fixture.path('ready.json'));
          if (leaderMode === 'early') {
            while (child.exitCode === null) await delay(10);
          }
          let reads = 0;
          vi.spyOn(Date, 'now').mockImplementation(
            () => originalNow() + (reads++ === 0 ? 0 : 60_000),
          );
          terminateChildProcessTree(child);
          const error = await waitForChildProcessTreeTermination(child);
          vi.restoreAllMocks();
          expect(error).toBeUndefined();
          expect(isAlive(group.pid)).toBe(false);
          expect(isAlive(group.child)).toBe(false);
        } finally {
          vi.restoreAllMocks();
          cleanGroup(group?.pid ?? child.pid);
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );

    it.each([
      ['stubborn', 'stubborn', 'direct'],
      ['responsive', 'stubborn', 'direct'],
      ['early', 'stubborn', 'direct'],
      ['responsive', 'responsive', 'direct'],
      ['responsive', 'stubborn', 'host'],
      ['responsive', 'stubborn', 'shutdown'],
    ])(
      'terminates descendants: leader %s, child %s, entry %s',
      async (leaderMode, childMode, entry) => {
        const fixture = await createGroupFixture(leaderMode, childMode);
        let child: ChildProcess | undefined;
        let group: { pid: number; child: number } | undefined;
        const controller = new AbortController();
        const spec = {
          command: process.execPath,
          args: [fixture.path('leader.cjs')],
          cwd: fixture.rootDir,
          env: process.env,
          shell: false,
          stdio: 'ignore' as const,
        };
        try {
          const pending =
            entry === 'direct'
              ? undefined
              : runCheckerSpawnMeasured(spec, { signal: controller.signal });
          if (entry === 'direct')
            child = spawn(spec.command, spec.args, {
              cwd: fixture.rootDir,
              detached: true,
              stdio: 'ignore',
            });
          group = await waitForReady(fixture.path('ready.json'));
          if (leaderMode === 'early') {
            while (child!.exitCode === null) await delay(10);
          }
          if (entry === 'shutdown') {
            await disposeCheckerProcessHostForTesting();
            for (let index = 0; index < 150 && isAlive(group.child); index += 1)
              await delay(20);
          } else if (entry === 'host') {
            controller.abort(new Error('cancel owned group'));
            expect((await pending)!.status).toBe(1);
          } else {
            terminateChildProcessTree(child!);
            // A second request must join the same pending cleanup.
            terminateChildProcessTree(child!);
            expect(
              await waitForChildProcessTreeTermination(child!),
            ).toBeUndefined();
          }
          expect(isAlive(group.child)).toBe(false);
          expect(isAlive(group.pid)).toBe(false);
        } finally {
          cleanGroup(group?.pid ?? child?.pid);
          await disposeCheckerProcessHostForTesting();
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );
  },
);
