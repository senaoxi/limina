import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
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
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-process-tree-'));
  const fixturePath = createFixturePathResolver(rootDir);
  const childScript = [
    "const fs = require('node:fs');",
    childMode === 'stubborn' ? "process.on('SIGTERM', () => {});" : '',
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
  await mkdir(rootDir, { recursive: true });
  await writeFile(fixturePath('leader.cjs'), script);
  return { rootDir, path: fixturePath };
}

async function waitForReady(
  file: string,
): Promise<{ pid: number; child: number }> {
  for (let i = 0; i < 150; i += 1) {
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
    /* The owned group already exited. */
  }
}

afterEach(() => disposeCheckerProcessHostForTesting());

describe.skipIf(process.platform === 'win32')(
  'POSIX checker process groups',
  () => {
    it.each([
      ['direct', 'responsive', 0],
      ['direct', 'stubborn', 7],
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
          const pending =
            entry === 'direct'
              ? spawnAndMeasure(spec)
              : runCheckerSpawnMeasured(spec);
          group = await waitForReady(fixture.path('ready.json'));
          const result = await pending;
          expect(result).toMatchObject({ status });
          expect(result.error).toBeUndefined();
          expect(isAlive(group.child)).toBe(false);
          expect(isAlive(group.pid)).toBe(false);
        } finally {
          cleanGroup(group?.pid);
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
            disposeCheckerProcessHostForTesting();
            for (let i = 0; i < 150 && isAlive(group.child); i += 1)
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
          disposeCheckerProcessHostForTesting();
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );
  },
);
