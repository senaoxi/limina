import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initializationFiles, initializationTask } from '../tasks/I01.ts';
import { captureTaskSnapshot } from './capture-policy.ts';
import { createExperiment, freezeTaskIdentity } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { validateMutations } from './mutation.ts';
import type { AttemptFacts } from './outcome.ts';
import {
  type AttemptRecord,
  type EvidenceReference,
  RunStore,
} from './run-store.ts';
import { captureSnapshot, sha256 } from './snapshot.ts';

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-journal-'));
  const root = await realpath(temporary);
  const source = path.join(root, 'source');
  mkdirSync(source);
  for (const [file, contents] of Object.entries(initializationFiles)) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const snapshot = await captureSnapshot(source, 'F0');
  const fixed = contentIdentity('fixed offline fixture');
  const task = initializationTask(snapshot, {
    closure: fixed,
    toolchain: fixed,
    grader: fixed,
  });
  const start = await captureTaskSnapshot(source, 'S0', task);
  writeFileSync(path.join(source, '.gitignore'), '.limina/\n');
  const final = await captureTaskSnapshot(source, 'S1', task);
  const plan = createExperiment({
    kind: 'smoke',
    seed: 'fixed-seed',
    preparedInputsDigest: fixed,
    runnerDigest: fixed,
    toolchainDigest: fixed,
    contextDigest: fixed,
    imageDigest: fixed,
    tasks: [freezeTaskIdentity(task, fixed, fixed)],
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: fixed },
      { id: 'explicit-skill', skillDigest: fixed },
    ],
  });
  const directory = path.join(root, 'run');
  const store = new RunStore(directory, plan);
  const facts: AttemptFacts = {
    execution: { status: 'completed', exitCode: 0 },
    captureStatus: 'complete',
    traceStatus: 'complete',
    mutation: validateMutations(task, start, final),
    grade: {
      taskId: task.id,
      graderDigest: fixed,
      status: 'complete',
      assertions: task.gradingContract.requiredAssertions.map((id) => ({
        id,
        passed: true,
      })),
    },
  };
  const evidence: EvidenceReference[] = [];
  for (const kind of [
    'fixture',
    'start',
    'final',
    'trace',
    'assertions',
  ] as const) {
    const name = `${kind}.json`;
    const content = JSON.stringify({ kind, syntheticOfflineTest: true });
    writeFileSync(path.join(directory, name), content);
    evidence.push({ kind, path: name, sha256: sha256(content) });
  }
  const data: Pick<
    AttemptRecord,
    'facts' | 'usage' | 'time' | 'activation' | 'evidence'
  > = {
    facts,
    usage: null,
    time: { agentMs: null, endToEndMs: null },
    activation: {
      installed: 'unknown',
      discovered: 'unknown',
      used: 'unknown',
    },
    evidence,
  };
  return { root, directory, store, plan, task, data };
}

test('journal resumes remaining slots, never retries an Agent failure or overwrites a result', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.throws(
    () => f.store.startNext({ slotId: 'stale-claim', ordinal: 1 }),
    /slot claim changed/,
  );
  assert.equal(f.store.summary().inFlight, null);
  const first = f.store.startNext()!;
  assert.throws(() => f.store.startNext(), /Unfinished attempt/);
  const failed = f.store.finish(first.runId, f.task, {
    ...f.data,
    facts: { ...f.data.facts, execution: { status: 'completed', exitCode: 7 } },
  });
  assert.equal(failed.outcome.status, 'agent_error');
  assert.throws(
    () => f.store.finish(first.runId, f.task, f.data),
    /already finished/,
  );
  const resumed = new RunStore(f.directory, f.plan);
  const second = resumed.startNext()!;
  assert.notEqual(second.slotId, first.slotId);
  assert.equal(second.ordinal, 1);
  resumed.finish(second.runId, f.task, f.data);
  assert.equal(resumed.summary().attempts.length, 2);
  const mutation = resumed.summary().attempts[1]!.facts.mutation;
  assert.ok(mutation?.status === 'accepted');
  assert.equal(mutation.changes[0]?.path, '.gitignore');
  assert.equal(
    resumed.summary().slots.filter((slot) => slot.status === 'not_run').length,
    1,
  );
  writeFileSync(path.join(f.directory, 'trace.json'), 'lost trace content');
  const summary = resumed.summary();
  assert.equal(
    summary.slots.find((slot) => slot.slot.id === first.slotId)?.status,
    'agent_error',
  );
  assert.equal(
    summary.slots.find((slot) => slot.slot.id === second.slotId)?.status,
    'unknown',
  );
  assert.throws(
    () =>
      new RunStore(
        f.directory,
        createExperiment({ ...f.plan.inputs, seed: 'different order' }),
      ),
    /different frozen experiment/,
  );
});

test('only captured infrastructure evidence authorizes one replacement; all attempts remain recorded', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = f.store.startNext()!;
  const facts: AttemptFacts = {
    ...f.data.facts,
    execution: {
      status: 'infra_error',
      evidence: {
        phase: 'transport',
        recordId: contentIdentity('missing evidence'),
      },
    },
  };
  assert.throws(
    () => f.store.finish(first.runId, f.task, { ...f.data, facts }),
    /captured evidence/,
  );
  const content = 'synthetic transport-failure observation';
  writeFileSync(path.join(f.directory, 'failure.txt'), content);
  facts.execution = {
    status: 'infra_error',
    evidence: { phase: 'transport', recordId: sha256(content) },
  };
  const data = {
    ...f.data,
    facts,
    evidence: [
      ...f.data.evidence,
      {
        kind: 'infrastructure' as const,
        path: 'failure.txt',
        sha256: sha256(content),
      },
    ],
  };
  f.store.finish(first.runId, f.task, data);
  const replacement = f.store.startNext()!;
  assert.equal(replacement.slotId, first.slotId);
  assert.equal(replacement.ordinal, 2);
  f.store.finish(replacement.runId, f.task, data);
  assert.notEqual(f.store.next()!.slot.id, first.slotId);
  assert.equal(f.store.summary().attempts.length, 2);
});

test('unfinished state, lost artifacts and partial journal cannot become successful empty attempts', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const started = f.store.startNext()!;
  const resumed = new RunStore(f.directory, f.plan);
  assert.throws(() => resumed.startNext(), /reconciliation/);
  assert.equal(
    resumed.summary().slots.filter((slot) => slot.status === 'in_flight')
      .length,
    1,
  );
  assert.throws(
    () => resumed.finish(started.runId, f.task, { ...f.data, evidence: [] }),
    /Passing attempts require/,
  );
  writeFileSync(path.join(f.directory, 'final.json'), 'tampered artifact');
  assert.throws(
    () => resumed.finish(started.runId, f.task, f.data),
    /evidence changed/,
  );
  const unknown = resumed.finish(started.runId, f.task, {
    ...f.data,
    evidence: [],
    facts: {
      execution: { status: 'unknown' },
      captureStatus: 'unknown',
      traceStatus: 'unknown',
      mutation: null,
      grade: null,
    },
  });
  assert.equal(unknown.outcome.status, 'unknown');
  appendFileSync(path.join(f.directory, 'attempts.jsonl'), '{');
  assert.throws(() => resumed.next(), /Incomplete attempt journal/);
});
