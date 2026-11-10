import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
  return {
    root,
    directory,
    store,
    plan,
    task,
    data,
    snapshot,
    start,
    final,
    fixed,
  };
}

async function gradingReviewFixture(isKnownFailure = false) {
  const f = await fixture();
  const data = structuredClone(f.data);
  data.facts.grade = { ...data.facts.grade!, status: 'error', assertions: [] };
  if (isKnownFailure)
    data.facts.grade = {
      ...f.data.facts.grade!,
      assertions: f.data.facts.grade!.assertions.map((a, index) => ({
        ...a,
        passed: index !== 0,
      })),
    };
  for (const [kind, snapshot] of [
    ['fixture', f.snapshot],
    ['start', f.start],
    ['final', f.final],
  ] as const) {
    const reference = data.evidence.find(
      (reference) => reference.kind === kind,
    )!;
    const bytes = JSON.stringify(snapshot);
    writeFileSync(path.join(f.directory, reference.path), bytes);
    reference.sha256 = sha256(bytes);
  }
  const original = f.store.finish(f.store.startNext()!.runId, f.task, data);
  const grade = {
    report: f.data.facts.grade!,
    commands: [{ exitCode: 0, timedOut: false }],
  };
  const bytes = JSON.stringify(grade);
  writeFileSync(path.join(f.directory, 'review-assertions.json'), bytes);
  const assertions: EvidenceReference = {
    kind: 'assertions',
    path: 'review-assertions.json',
    sha256: sha256(bytes),
  };
  const proof = {
    version: 1,
    kind: 'offline-grading-review',
    modelCalls: 0,
    runId: original.runId,
    experimentIdentity: f.plan.identity,
    originalRecordDigest: contentIdentity(original),
    originalEvidence: original.evidence,
    gradingToolchain: 'fixed offline fixture',
    gradingTimeoutMs: 300_000,
    elapsedMs: 10,
    assertionsSha256: assertions.sha256,
  };
  const proofBytes = JSON.stringify(proof);
  writeFileSync(path.join(f.directory, 'review-proof.json'), proofBytes);
  const review = {
    runId: original.runId,
    task: f.task,
    originalRecordDigest: contentIdentity(original),
    setupDigest: f.fixed,
    gradingToolchainDigest: f.fixed,
    assertions,
    evidence: {
      kind: 'grading-review' as const,
      path: 'review-proof.json',
      sha256: sha256(proofBytes),
    },
  };
  return { ...f, original, review, proof, grade };
}

test('appends a grading review without another execution and preserves the original journal prefix', async (t) => {
  const f = await gradingReviewFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.directory, 'attempts.jsonl');
  const before = readFileSync(file);
  const result = f.store.reviewGrading(f.review);
  assert.equal(result.outcome.status, 'passed');
  assert.equal(result.runId, f.original.runId);
  assert.deepEqual(result.time, f.original.time);
  assert.deepEqual(result.usage, f.original.usage);
  assert.equal(f.store.summary().attempts.length, 1);
  assert.equal(f.store.summary().inFlight, null);
  assert.equal(f.store.next()!.ordinal, 1);
  assert.notEqual(f.store.next()!.slot.id, result.slot.id);
  assert.deepEqual(readFileSync(file).subarray(0, before.length), before);
  const historical = RunStore.openAt(
    f.directory,
    before.length,
    sha256(before),
  );
  assert.equal(
    historical.summary().attempts[0]!.outcome.status,
    'grader_error',
  );
  assert.equal(
    RunStore.open(f.directory).summary().attempts[0]!.outcome.status,
    'passed',
  );
  assert.equal(
    result.gradingReview!.originalRecordDigest,
    contentIdentity(f.original),
  );
  assert.throws(() => f.store.reviewGrading(f.review), /grading review/);
  assert.throws(
    () => RunStore.open(f.directory).reviewGrading(f.review),
    /Read-only/,
  );
});

test('rejects a grading review with foreign inputs, missing assertions or changed evidence', async (t) => {
  const f = await gradingReviewFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const before = readFileSync(path.join(f.directory, 'attempts.jsonl'));
  for (const changes of [
    { runId: 'foreign' },
    { originalRecordDigest: contentIdentity('foreign') },
    { setupDigest: contentIdentity('other setup') },
    { gradingToolchainDigest: contentIdentity('other grader runtime') },
    { task: { ...f.task, prompt: 'different task contract' } },
  ])
    assert.throws(
      () => f.store.reviewGrading({ ...f.review, ...changes }),
      /grading review/,
    );
  const assertionsFile = path.join(f.directory, f.review.assertions.path);
  const missing = JSON.stringify({
    ...f.grade,
    report: { ...f.grade.report, assertions: [] },
  });
  writeFileSync(assertionsFile, missing);
  const proof = JSON.stringify({
    ...f.proof,
    assertionsSha256: sha256(missing),
  });
  writeFileSync(path.join(f.directory, f.review.evidence.path), proof);
  const changed = {
    ...f.review,
    assertions: { ...f.review.assertions, sha256: sha256(missing) },
    evidence: { ...f.review.evidence, sha256: sha256(proof) },
  };
  assert.throws(() => f.store.reviewGrading(changed), /grading review/);
  assert.deepEqual(
    readFileSync(path.join(f.directory, 'attempts.jsonl')),
    before,
  );
});

test('keeps review failures final and rejects changes to its resource and provenance contract', async (t) => {
  const f = await gradingReviewFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const changes of [
    { gradingTimeoutMs: 300_001 },
    { modelCalls: 1 },
    { gradingToolchain: 'different runtime' },
    { originalEvidence: [] },
  ]) {
    const bytes = JSON.stringify({ ...f.proof, ...changes });
    writeFileSync(path.join(f.directory, f.review.evidence.path), bytes);
    assert.throws(
      () =>
        f.store.reviewGrading({
          ...f.review,
          evidence: { ...f.review.evidence, sha256: sha256(bytes) },
        }),
      /grading review/,
    );
  }
  const failedGrade = {
    ...f.grade,
    report: {
      ...f.grade.report,
      assertions: f.grade.report.assertions.map((a, index) => ({
        ...a,
        passed: index !== 0,
      })),
    },
  };
  const bytes = JSON.stringify(failedGrade);
  writeFileSync(path.join(f.directory, f.review.assertions.path), bytes);
  const proof = JSON.stringify({ ...f.proof, assertionsSha256: sha256(bytes) });
  writeFileSync(path.join(f.directory, f.review.evidence.path), proof);
  const input = {
    ...f.review,
    assertions: { ...f.review.assertions, sha256: sha256(bytes) },
    evidence: { ...f.review.evidence, sha256: sha256(proof) },
  };
  assert.equal(f.store.reviewGrading(input).outcome.status, 'assertion_failed');
  assert.throws(() => f.store.reviewGrading(input), /grading review/);
  const known = await gradingReviewFixture(true);
  t.after(() => rm(known.root, { recursive: true, force: true }));
  assert.equal(known.original.outcome.status, 'assertion_failed');
  assert.throws(
    () => known.store.reviewGrading(known.review),
    /grading review/,
  );
});

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
