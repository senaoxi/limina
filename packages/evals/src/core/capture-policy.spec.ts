import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initializationTask } from '../tasks/I01.ts';
import {
  assertFixtureCaptureScope,
  captureRoots,
  captureTaskSnapshot,
} from './capture-policy.ts';
import { freezeTaskIdentity } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { validateMutations } from './mutation.ts';
import { captureSnapshot, compareAgentSnapshots } from './snapshot.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-capture-policy-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  await writeFile(path.join(root, 'src/index.ts'), 'export const value=1;');
  const frozen = await captureSnapshot(root, 'F0');
  const identity = contentIdentity('offline capture test');
  const task = initializationTask(frozen, {
    closure: identity,
    toolchain: identity,
    grader: identity,
  });
  return { root, frozen, task, identity };
}

test('frozen exclusions omit runtime caches but cannot hide ignored source changes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assertFixtureCaptureScope(f.task, f.frozen);
  const start = await captureTaskSnapshot(f.root, 'S0', f.task);
  await mkdir(path.join(f.root, '.limina'));
  await writeFile(path.join(f.root, '.limina/cache'), 'ephemeral');
  await writeFile(path.join(f.root, '.gitignore'), '*');
  await writeFile(path.join(f.root, 'src/index.ts'), 'export const value=2;');
  const final = await captureTaskSnapshot(f.root, 'S1', f.task);
  assert.deepEqual(
    compareAgentSnapshots(start, final).map((change) => change.path),
    ['.gitignore', 'src/index.ts'],
  );
  assert.equal(validateMutations(f.task, start, final).status, 'unsafe');
  const omittedStart = await captureSnapshot(f.root, 'S0', {
    excludedRoots: ['src'],
  });
  const omittedFinal = await captureSnapshot(f.root, 'S1', {
    excludedRoots: ['src'],
  });
  assert.equal(
    validateMutations(f.task, omittedStart, omittedFinal).status,
    'unknown',
  );
});

test('meaningful cache state and generated delivery roots cannot be excluded', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const task = structuredClone(f.task);
  task.capturePolicy.excludedRoots = ['.eval-tmp', 'node_modules'];
  task.capturePolicy.requiredRoots = ['.limina', 'dist'];
  const start = await captureTaskSnapshot(f.root, 'S0', task);
  await mkdir(path.join(f.root, '.limina'));
  await writeFile(path.join(f.root, '.limina/last-success'), 'old receipt');
  const final = await captureTaskSnapshot(f.root, 'S1', task);
  assert.ok(
    compareAgentSnapshots(start, final).some(
      (change) => change.path === '.limina/last-success',
    ),
  );
  task.capturePolicy.excludedRoots.push('.limina');
  assert.throws(() => captureRoots(task), /required task state/);
  task.capturePolicy.excludedRoots = ['packages/ui/.limina'];
  assert.deepEqual(captureRoots(task), ['packages/ui/.limina']);
  task.capturePolicy.requiredRoots.push(
    'packages/ui/.limina/check/receipt.json',
  );
  assert.throws(() => captureRoots(task), /required task state/);
  task.capturePolicy.excludedRoots = ['dist'];
  assert.throws(() => captureRoots(task), /Only declared runtime/);
  const withCache = await captureSnapshot(f.root, 'F0');
  assert.throws(
    () => assertFixtureCaptureScope(f.task, withCache),
    /omit frozen fixture/,
  );
});

test('capture changes alter execution and grading identity and never exclude Skill', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const original = freezeTaskIdentity(f.task, f.identity, f.identity);
  const task = structuredClone(f.task);
  task.capturePolicy.excludedRoots = ['node_modules'];
  const changed = freezeTaskIdentity(task, f.identity, f.identity);
  assert.notEqual(original.executionDigest, changed.executionDigest);
  assert.notEqual(original.gradingDigest, changed.gradingDigest);
  task.capturePolicy.excludedRoots = ['.agents'];
  assert.throws(() => captureRoots(task));
});
