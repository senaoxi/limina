import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createExperiment,
  freezeTaskIdentity,
  taskCatalog,
} from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { projectDevelopmentDiagnostics } from './revision-export.ts';

const fixed = contentIdentity('synthetic offline export input');
function tasks(split: 'dev' | 'sealed') {
  return taskCatalog
    .filter((value) => value.split === split)
    .map((metadata) => {
      const task: TaskSpec = {
        ...metadata,
        version: 2,
        prompt: 'Synthetic offline task',
        fixtureDigest: fixed,
        capturePolicy: { excludedRoots: [], requiredRoots: [] },
        mutationPolicy: { rules: [], protectedRoots: [] },
        dependencyPolicy: {
          inputs: [],
          variants: [
            { id: 'empty', inputsDigest: fixed, closureDigest: fixed },
          ],
        },
        installPlan: {
          toolchainDigest: fixed,
          manager: 'pnpm',
          managerVersion: '12.10.1',
          offline: true,
          ignoreScripts: true,
          setupSteps: [],
        },
        gradingContract: {
          graderDigest: fixed,
          requiredAssertions: ['semantic'],
        },
      };
      return { task, identity: freezeTaskIdentity(task, fixed, fixed) };
    });
}
async function fixture(split: 'dev' | 'sealed' = 'dev') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-revision-'));
  const root = await realpath(temporary);
  const definitions = tasks(split);
  const plan = createExperiment({
    kind: split === 'dev' ? 'development' : 'sealed',
    seed: 'RAW_CONTROLLER_ONLY_SEED',
    preparedInputsDigest: fixed,
    runnerDigest: fixed,
    toolchainDigest: fixed,
    contextDigest: fixed,
    imageDigest: fixed,
    tasks: definitions.map((value) => value.identity),
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: fixed },
    ],
  });
  return {
    root,
    definitions,
    store: new RunStore(path.join(root, 'run'), plan),
  };
}
async function recordFailure(value: Awaited<ReturnType<typeof fixture>>) {
  const started = value.store.startNext()!;
  const slot = value.store.manifest.slots.find(
    (item) => item.id === started.slotId,
  )!;
  const task = value.definitions.find(
    (item) => item.task.id === slot.taskId,
  )!.task;
  const evidence = [];
  for (const kind of [
    'fixture',
    'start',
    'final',
    'trace',
    'assertions',
  ] as const) {
    const name = `RAW_PRIVATE_${kind}.json`;
    const bytes = JSON.stringify({
      syntheticOffline: true,
      text: 'RAW_HISTORY_MUST_NOT_EXPORT',
    });
    await writeFile(path.join(value.store.directory, name), bytes);
    evidence.push({ kind, path: name, sha256: sha256(bytes) });
  }
  value.store.finish(started.runId, task, {
    facts: {
      execution: { status: 'completed', exitCode: 0 },
      captureStatus: 'complete',
      traceStatus: 'complete',
      mutation: {
        status: 'accepted',
        changes: [],
        dependencyVariant: task.dependencyPolicy.variants[0]!,
      },
      grade: {
        taskId: task.id,
        graderDigest: fixed,
        status: 'complete',
        assertions: [{ id: 'semantic', passed: false }],
      },
    },
    usage: null,
    time: { agentMs: null, endToEndMs: null },
    activation: {
      installed: 'unknown',
      discovered: 'unknown',
      used: 'unknown',
    },
    evidence,
  });
  return slot;
}

test('revision diagnostics retain actionable development assertions without raw controller fields', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const slot = await recordFailure(value);
  const projected = projectDevelopmentDiagnostics(
    value.store,
    value.definitions,
  );
  const selected = projected.find(
    (item) =>
      item.taskId === slot.taskId &&
      item.condition === slot.condition &&
      item.repetition === slot.repetition,
  )!;
  assert.equal(projected.length, 102);
  assert.equal(selected.status, 'assertion_failed');
  assert.deepEqual(selected.assertions, [{ id: 'semantic', passed: false }]);
  const encoded = JSON.stringify(projected);
  assert.ok(!encoded.includes('RAW_'));
  assert.ok(!encoded.includes(value.store.directory));
  assert.ok(!encoded.includes('runId'));
  const journal = await readFile(
    path.join(value.store.directory, 'attempts.jsonl'),
    'utf8',
  );
  assert.ok(journal.includes('RAW_PRIVATE_'));
});

test('revision diagnostics reject sealed batches, changed identities and unfinished development execution', async (t) => {
  const sealed = await fixture('sealed');
  const development = await fixture();
  t.after(() =>
    Promise.all(
      [sealed, development].map((value) =>
        rm(value.root, { recursive: true, force: true }),
      ),
    ),
  );
  assert.throws(
    () => projectDevelopmentDiagnostics(sealed.store, sealed.definitions),
    /development-only/,
  );
  const altered = development.definitions.map((value, index) =>
    index === 0
      ? {
          ...value,
          identity: {
            ...value.identity,
            executionDigest: contentIdentity('other input'),
          },
        }
      : value,
  );
  assert.throws(
    () => projectDevelopmentDiagnostics(development.store, altered),
    /do not match/,
  );
  development.store.startNext();
  assert.throws(
    () =>
      projectDevelopmentDiagnostics(development.store, development.definitions),
    /in-flight/,
  );
});

test('lost development evidence produces unknown assertions instead of reusable failed or passed scores', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const slot = await recordFailure(value);
  await rm(path.join(value.store.directory, 'RAW_PRIVATE_trace.json'));
  const selected = projectDevelopmentDiagnostics(
    value.store,
    value.definitions,
  ).find(
    (item) =>
      item.taskId === slot.taskId &&
      item.condition === slot.condition &&
      item.repetition === slot.repetition,
  )!;
  assert.equal(selected.evidence, 'unknown');
  assert.deepEqual(selected.assertions, [{ id: 'semantic', passed: null }]);
});
