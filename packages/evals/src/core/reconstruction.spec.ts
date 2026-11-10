import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dependencyInputsIdentity } from './mutation.ts';
import {
  reconstructForVerifier,
  verifyReconstructedProject,
} from './reconstruction.ts';
import { captureSnapshot } from './snapshot.ts';
import type { TaskSpec } from './task.ts';

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-rebuild-'));
  const root = await realpath(temporary);
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'package.json'), '{"private":true}');
  await writeFile(path.join(source, 'old.bin'), Buffer.from([0, 255, 1]));
  const fixture = await captureSnapshot(source, 'F0');
  await writeFile(path.join(source, 'prepared.txt'), 'trusted setup');
  const start = await captureSnapshot(source, 'S0');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  const task: TaskSpec = {
    version: 2,
    id: 'reconstruction-contract',
    split: 'dev',
    domain: 'negative-control',
    prompt: 'Rename the binary file.',
    fixtureDigest: fixture.digest!,
    capturePolicy: { excludedRoots: [], requiredRoots: [] },
    mutationPolicy: {
      protectedRoots: [],
      rules: [
        { path: 'old.bin', operations: ['delete'] },
        { path: 'new.bin', operations: ['add'] },
        { path: 'package.json', operations: ['modify'] },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'none',
          inputsDigest: dependencyInputsIdentity(start, inputs),
          closureDigest: 'admitted-empty-closure',
        },
      ],
    },
    installPlan: {
      toolchainDigest: 'fixed',
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: 'fixed-grader',
      requiredAssertions: ['renamed'],
    },
  };
  await rm(path.join(source, 'old.bin'));
  await writeFile(path.join(source, 'new.bin'), Buffer.from([0, 255, 1]));
  const final = await captureSnapshot(source, 'S1');
  const prepareStart = (destination: string) =>
    writeFile(path.join(destination, 'prepared.txt'), 'trusted setup');
  return { root, source, fixture, start, final, task, prepareStart };
}

test('reconstructs only validated binary additions and deletions from an identical prepared baseline', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await reconstructForVerifier({
    ...f,
    destination: path.join(f.root, 'verifier'),
  });
  assert.equal(result.decision.status, 'accepted');
  assert.ok(result.project);
  assert.deepEqual(
    await readFile(path.join(result.project.directory, 'new.bin')),
    Buffer.from([0, 255, 1]),
  );
  await assert.rejects(
    readFile(path.join(result.project.directory, 'old.bin')),
    { code: 'ENOENT' },
  );
  await verifyReconstructedProject(result.project);
  await assert.rejects(
    verifyReconstructedProject({ ...result.project }),
    /not passed reconstruction/,
  );
  await writeFile(
    path.join(result.project.directory, 'new.bin'),
    'later tamper',
  );
  await assert.rejects(
    verifyReconstructedProject(result.project),
    /changed before verifier transfer/,
  );
});

test('refuses executable dependency inputs before invoking preparation', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(
    path.join(f.source, 'package.json'),
    '{"private":true,"scripts":{"preinstall":"touch sentinel"}}',
  );
  let preparations = 0;
  const result = await reconstructForVerifier({
    ...f,
    final: await captureSnapshot(f.source, 'S1'),
    destination: path.join(f.root, 'verifier'),
    prepareStart: async () => {
      preparations++;
    },
  });
  assert.equal(result.decision.status, 'unsafe');
  assert.equal(result.project, null);
  assert.equal(preparations, 0);
  await assert.rejects(readFile(path.join(f.source, 'sentinel')), {
    code: 'ENOENT',
  });
});

test('rejects incorrect setup and incomplete final capture without synthesizing a successful state', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    reconstructForVerifier({
      ...f,
      destination: path.join(f.root, 'wrong-baseline'),
      prepareStart: async (destination) => {
        await f.prepareStart(destination);
        await writeFile(path.join(destination, 'old.bin'), 'setup drift');
      },
    }),
    /Rebuilt S0 differs/,
  );
  let preparations = 0;
  const result = await reconstructForVerifier({
    ...f,
    final: { ...f.final, status: 'unknown', digest: null },
    destination: path.join(f.root, 'unknown'),
    prepareStart: async () => {
      preparations++;
    },
  });
  assert.equal(result.decision.status, 'unknown');
  assert.equal(preparations, 0);
});
