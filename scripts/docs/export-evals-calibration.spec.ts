import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { contentIdentity } from './evals-public-protocol';
import {
  exportCalibration,
  readCalibrationPublication,
} from './export-evals-calibration';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// Synthetic controller records exercise only the publication boundary, never a Grader.
async function fixture() {
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'limina-calibration-publication-'),
  );
  const root = await realpath(temporary);
  const references = new Map<
    string,
    { file: string; sha256: string; roles: string[] }
  >();
  const put = async (file: string, value: unknown) => {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    const bytes = JSON.stringify(value) + '\n';
    await writeFile(absolute, bytes);
    references.set(file, { file, sha256: hash(bytes), roles: [] });
    return { file, sha256: hash(bytes) };
  };
  const read = async (file: string) =>
    JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const sealed = new Set([
    'I02',
    'C03',
    'R01',
    'K02',
    'S03',
    'W01',
    'T02',
    'P03',
    'N02',
  ]);
  const domains = [
    ['I', 'initialization'],
    ['C', 'configuration'],
    ['R', 'reference-graph'],
    ['K', 'checker'],
    ['S', 'source-governance'],
    ['W', 'workflow'],
    ['T', 'troubleshooting'],
    ['P', 'package-release'],
    ['N', 'negative-control'],
  ];
  const tasks = domains.flatMap(([prefix, domain]) =>
    Array.from({ length: prefix === 'N' ? 2 : 3 }, (_, index) => {
      const id = `${prefix}0${index + 1}`;
      return {
        id,
        domain,
        split: sealed.has(id) ? 'sealed' : 'dev',
        role: prefix === 'N' ? 'negative-control' : 'main',
        specDigest: hash(`spec:${id}`),
        executionDigest: hash(`execution:${id}`),
        gradingDigest: hash(`grading:${id}`),
        graderDigest: hash(`grader:${id}`),
      };
    }),
  );
  const body = {
    schemaVersion: 1,
    revision: 'v2.1',
    tasks,
    prompt: 'SYNTHETIC_PRIVATE_PROMPT',
  };
  const bankId = contentIdentity(body);
  const bankReference = await put('private/bank.json', { ...body, id: bankId });
  const reviewRows = [];
  for (const task of tasks) {
    const review = await put(`private/${task.id}/review.json`, {
      taskId: task.id,
      status: 'passed',
      referenceAccess: false,
      graderAccess: false,
      adversarialChecks: [{ rawTrace: 'SYNTHETIC_PRIVATE_TRACE' }, {}, {}],
    });
    const independentVerification = await put(
      `private/${task.id}/verification.json`,
      {
        bankId,
        taskId: task.id,
        outcome: { status: 'passed' },
        grading: { report: { graderDigest: task.graderDigest } },
        referenceSolution: 'SYNTHETIC_PRIVATE_SOLUTION',
      },
    );
    const graderCalibration = await put(`private/${task.id}/calibration.json`, {
      task,
      graderDigest: task.graderDigest,
      modelCalls: 0,
      formalAttempt: false,
      results: [
        {
          caseId: 'valid',
          expected: 'passed',
          matched: true,
          outcome: { status: 'passed' },
        },
        {
          caseId: 'incorrect',
          expected: 'failed',
          matched: true,
          outcome: { status: 'assertion_failed' },
        },
        {
          caseId: 'unauthorized',
          expected: 'unsafe',
          matched: true,
          outcome: { status: 'unsafe_mutation' },
        },
      ],
    });
    const evidence = await put(`coordinator/final/tasks/${task.id}.json`, {
      bankId,
      taskId: task.id,
      status: 'passed',
      reviewerStatus: 'passed',
      frozenSubmissionGraderStatus: 'passed',
      referenceAccess: false,
      graderAccess: false,
      review,
      independentVerification,
      graderCalibration,
      privatePath: '/synthetic/private/controller',
    });
    reviewRows.push({ id: task.id, status: 'passed', evidence });
  }
  const publicInputAudit = await put('private/input-audit.json', {
    summary: {
      equivalentCount: 26,
      allEquivalentExcludingOnlyTopLevelBankId: true,
      sourcePacketsUnchangedAfterTests: true,
      bankIds: { new: [bankId] },
    },
  });
  await put('coordinator/final/task-calibration.json', {
    version: 2,
    kind: 'independent-task-calibration-suite',
    bankId,
    revision: 'v2.1',
    status: 'passed',
    reviewerMode: 'independent',
    referenceAccess: false,
    graderAccess: false,
    privateScoringFeedbackToReviewers: false,
    formalDispatchAuthorized: false,
    targetModelEvaluations: 0,
    reviewers: 8,
    additionalPublicInputAuditors: 1,
    completedAt: 2_208_988_800,
    taskExecutionRepeated: false,
    newBank: bankReference,
    publicInputAudit,
    tasks: reviewRows,
    counts: {
      tasks: 26,
      adversarialChecks: 78,
      graderCalibrationCases: 78,
      graderCalibrationMatched: 78,
    },
  });
  await put('coordinator/final/grader-calibration-summary.json', {
    bankId,
    tasks: 26,
    cases: 78,
    matched: 78,
    modelCalls: 0,
    classes: { passed: 26, failed: 26, unsafe: 26 },
  });
  const seal = async () => {
    const bytes =
      JSON.stringify({
        version: 1,
        kind: 'private-evidence-index',
        bankId,
        pathBase: 'reproduction root',
        files: references.values().toArray(),
      }) + '\n';
    await writeFile(
      path.join(root, 'coordinator/final/evidence-index.json'),
      bytes,
    );
    return hash(bytes);
  };
  return { root, read, put, seal, bankId, sourceHash: await seal() };
}

it('publishes only allowlisted calibration counts with immutable snapshots and an explicit latest pointer', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true }));
  const output = path.join(f.root, 'evals-latest-bank.json');
  const result = await exportCalibration(f.root, f.sourceHash, output);
  assert.equal(result.bankId, f.bankId);
  assert.deepEqual(result.inventory, {
    tasks: 26,
    development: 17,
    sealed: 9,
    domains: 8,
    negativeControls: 2,
  });
  assert.deepEqual(result.graderCalibration, {
    cases: 78,
    matched: 78,
    correct: 26,
    incorrect: 26,
    unsafe: 26,
  });
  assert.equal(result.independentReview.passed, 26);
  assert.equal(result.independentReview.adversarialChecks, 78);
  assert.equal(result.scope, 'task-calibration');
  assert.equal(result.modelPerformanceIncluded, false);
  const bytes = await readFile(output, 'utf8');
  assert.ok(!bytes.includes('SYNTHETIC_PRIVATE'));
  assert.ok(!bytes.includes('/synthetic/private'));
  assert.ok(!bytes.includes(f.root));
  assert.ok(!Object.hasOwn(result, 'models'));
  const archive = path.join(f.root, 'evals-calibrations');
  const [name] = await readdir(archive);
  assert.ok(name);
  assert.equal(await readFile(path.join(archive, name), 'utf8'), bytes);
  await exportCalibration(f.root, f.sourceHash, output);
  assert.equal(await readFile(output, 'utf8'), bytes);
  assert.equal((await readdir(archive)).length, 1);
});

it('rejects changed source bytes, cross-bank grades and contradictory calibration evidence', async (t) => {
  const cases = [
    {
      name: 'wrong source pin',
      expected: /Calibration source index differs/,
      mutate: async (_f: Awaited<ReturnType<typeof fixture>>) => 'f'.repeat(64),
    },
    {
      name: 'changed frozen file',
      expected: /Frozen calibration evidence changed/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await writeFile(path.join(f.root, 'private/I01/review.json'), '{}\n');
        return f.sourceHash;
      },
    },
    {
      name: 'foreign bank',
      expected: /Submission belongs to another bank/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        const file = 'private/I01/verification.json';
        const value = await f.read(file);
        value.bankId = 'a'.repeat(64);
        const reference = await f.put(file, value);
        const receiptFile = 'coordinator/final/tasks/I01.json';
        const receipt = await f.read(receiptFile);
        receipt.independentVerification = reference;
        const evidence = await f.put(receiptFile, receipt);
        const suite = await f.read('coordinator/final/task-calibration.json');
        suite.tasks.find((row: { id: string }) => row.id === 'I01').evidence =
          evidence;
        await f.put('coordinator/final/task-calibration.json', suite);
        return f.seal();
      },
    },
    {
      name: 'wrong repair reported as matched',
      expected: /Calibration accepted an incorrect outcome/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        const file = 'private/I01/calibration.json';
        const value = await f.read(file);
        value.results[1].outcome.status = 'passed';
        const reference = await f.put(file, value);
        const receiptFile = 'coordinator/final/tasks/I01.json';
        const receipt = await f.read(receiptFile);
        receipt.graderCalibration = reference;
        const evidence = await f.put(receiptFile, receipt);
        const suite = await f.read('coordinator/final/task-calibration.json');
        suite.tasks.find((row: { id: string }) => row.id === 'I01').evidence =
          evidence;
        await f.put('coordinator/final/task-calibration.json', suite);
        return f.seal();
      },
    },
    {
      name: 'missing task',
      expected: /Independent review inventory is incomplete/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        const suite = await f.read('coordinator/final/task-calibration.json');
        suite.tasks.pop();
        await f.put('coordinator/final/task-calibration.json', suite);
        return f.seal();
      },
    },
    {
      name: 'reference access',
      expected: /Review was exposed to a reference solution/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        const suite = await f.read('coordinator/final/task-calibration.json');
        suite.referenceAccess = true;
        await f.put('coordinator/final/task-calibration.json', suite);
        return f.seal();
      },
    },
    {
      name: 'model run mislabeled as calibration',
      expected: /Model results cannot be published as calibration/,
      mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
        const suite = await f.read('coordinator/final/task-calibration.json');
        suite.targetModelEvaluations = 1;
        await f.put('coordinator/final/task-calibration.json', suite);
        return f.seal();
      },
    },
  ];
  for (const c of cases)
    await t.test(c.name, async () => {
      const f = await fixture();
      try {
        await assert.rejects(
          readCalibrationPublication(f.root, await c.mutate(f)),
          c.expected,
        );
      } finally {
        await rm(f.root, { recursive: true });
      }
    });
});

it('keeps failed review rows and earlier snapshots when publishing a later summary', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true }));
  const output = path.join(f.root, 'evals-latest-bank.json');
  const original = await exportCalibration(f.root, f.sourceHash, output);
  const originalBytes = await readFile(output, 'utf8');
  const review = await f.read('private/I01/review.json');
  review.status = 'failed';
  const reviewReference = await f.put('private/I01/review.json', review);
  const verification = await f.read('private/I01/verification.json');
  verification.outcome.status = 'assertion_failed';
  const verificationReference = await f.put(
    'private/I01/verification.json',
    verification,
  );
  const receipt = await f.read('coordinator/final/tasks/I01.json');
  Object.assign(receipt, {
    status: 'failed',
    reviewerStatus: 'failed',
    frozenSubmissionGraderStatus: 'assertion_failed',
    review: reviewReference,
    independentVerification: verificationReference,
  });
  const evidence = await f.put('coordinator/final/tasks/I01.json', receipt);
  const suite = await f.read('coordinator/final/task-calibration.json');
  suite.status = 'failed';
  const row = suite.tasks.find((entry: { id: string }) => entry.id === 'I01');
  row.status = 'failed';
  row.evidence = evidence;
  await f.put('coordinator/final/task-calibration.json', suite);
  const result = await exportCalibration(f.root, await f.seal(), output);
  assert.equal(result.tasks.length, 26);
  assert.equal(result.independentReview.passed, 25);
  assert.equal(result.independentReview.status, 'failed');
  assert.equal(
    result.tasks.find((entry) => entry.id === 'I01')?.submissionStatus,
    'assertion_failed',
  );
  assert.equal(
    (await readdir(path.join(f.root, 'evals-calibrations'))).length,
    2,
  );
  assert.equal(
    await readFile(
      path.join(
        f.root,
        'evals-calibrations',
        `${original.bankId}-${original.identity}.json`,
      ),
      'utf8',
    ),
    originalBytes,
  );
});
