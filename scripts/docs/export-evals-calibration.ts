import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { format } from 'prettier';
import {
  type CalibrationStatus,
  contentIdentity,
  type PublicBankCalibration,
} from './evals-public-protocol';

interface Reference {
  file: string;
  sha256: string;
}
interface BankTask {
  id: string;
  domain: string;
  split: 'dev' | 'sealed';
  role: 'main' | 'negative-control';
  specDigest: string;
  executionDigest: string;
  gradingDigest: string;
  graderDigest: string;
}
interface CalibrationCase {
  caseId: string;
  expected: 'passed' | 'failed' | 'unsafe';
  matched: boolean;
  outcome: { status: string };
}
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const assertDigest = (value: string) => assert.match(value, /^[a-f\d]{64}$/);
const count = (value: number) => {
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  return value;
};
const status = (value: CalibrationStatus) => {
  assert.ok(['passed', 'failed', 'ambiguous', 'blocked'].includes(value));
  return value;
};
const outcomeStatuses = new Set([
  'passed',
  'assertion_failed',
  'unsafe_mutation',
  'agent_error',
  'agent_timeout',
  'infra_error',
  'grader_error',
  'unknown',
  'cancelled',
  'not_run',
]);
const domains: Record<string, string> = {
  I: 'initialization',
  C: 'configuration',
  R: 'reference-graph',
  K: 'checker',
  S: 'source-governance',
  W: 'workflow',
  T: 'troubleshooting',
  P: 'package-release',
  N: 'negative-control',
};
const sealedIds = new Set([
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

function readTaskCalibration(
  task: BankTask,
  admitted:
    | { id: string; status: CalibrationStatus; evidence: Reference }
    | undefined,
  bankId: string,
  read: <T>(reference: Reference) => T,
) {
  const totals = { cases: 0, matched: 0, correct: 0, incorrect: 0, unsafe: 0 };
  const expectedOutcome = {
    passed: 'passed',
    failed: 'assertion_failed',
    unsafe: 'unsafe_mutation',
  };
  assert.match(task.id, /^(?:[ICRKSWTP]0[1-3]|N0[12])$/);
  assert.equal(task.domain, domains[task.id[0]!]);
  assert.equal(task.split, sealedIds.has(task.id) ? 'sealed' : 'dev');
  assert.equal(task.role, task.id[0] === 'N' ? 'negative-control' : 'main');
  for (const field of [
    'specDigest',
    'executionDigest',
    'gradingDigest',
    'graderDigest',
  ] as const)
    assertDigest(task[field]);
  assert.ok(admitted, 'Bank task has no independent review');
  const receipt = read<{
    bankId: string;
    taskId: string;
    status: CalibrationStatus;
    reviewerStatus: CalibrationStatus;
    frozenSubmissionGraderStatus: string;
    referenceAccess: boolean;
    graderAccess: boolean;
    review: Reference;
    independentVerification: Reference;
    graderCalibration: Reference;
  }>(admitted.evidence);
  assert.equal(receipt.bankId, bankId);
  assert.equal(receipt.taskId, task.id);
  assert.equal(receipt.status, admitted.status);
  assert.equal(receipt.referenceAccess, false);
  assert.equal(receipt.graderAccess, false);
  const review = read<{
    taskId: string;
    status: CalibrationStatus;
    referenceAccess: boolean;
    graderAccess: boolean;
    adversarialChecks: unknown[];
  }>(receipt.review);
  assert.equal(review.taskId, task.id);
  assert.equal(review.status, receipt.reviewerStatus);
  assert.equal(review.referenceAccess, false);
  assert.equal(review.graderAccess, false);
  assert.ok(
    Array.isArray(review.adversarialChecks) &&
      review.adversarialChecks.length >= 3,
  );
  const verification = read<{
    bankId: string;
    taskId: string;
    outcome: { status: string };
    grading: { report: { graderDigest: string } };
  }>(receipt.independentVerification);
  assert.equal(
    verification.bankId,
    bankId,
    'Submission belongs to another bank',
  );
  assert.equal(verification.taskId, task.id);
  assert.equal(verification.grading.report.graderDigest, task.graderDigest);
  assert.equal(
    verification.outcome.status,
    receipt.frozenSubmissionGraderStatus,
  );
  assert.ok(outcomeStatuses.has(verification.outcome.status));
  if (receipt.status === 'passed') {
    assert.equal(review.status, 'passed');
    assert.equal(verification.outcome.status, 'passed');
  }
  const graded = read<{
    task: {
      id: string;
      specDigest: string;
      executionDigest: string;
      gradingDigest: string;
    };
    graderDigest: string;
    modelCalls: number;
    formalAttempt: boolean;
    results: CalibrationCase[];
  }>(receipt.graderCalibration);
  for (const field of [
    'id',
    'specDigest',
    'executionDigest',
    'gradingDigest',
  ] as const)
    assert.equal(
      graded.task[field],
      task[field],
      'Calibration belongs to another task identity',
    );
  assert.equal(graded.graderDigest, task.graderDigest);
  assert.equal(graded.modelCalls, 0);
  assert.equal(graded.formalAttempt, false);
  assert.ok(graded.results.some((c) => c.expected === 'passed'));
  assert.ok(graded.results.some((c) => c.expected !== 'passed'));
  assert.equal(
    new Set(graded.results.map((c) => c.caseId)).size,
    graded.results.length,
  );
  let matched = 0;
  for (const result of graded.results) {
    assert.ok(Object.hasOwn(expectedOutcome, result.expected));
    assert.equal(typeof result.matched, 'boolean');
    if (result.matched)
      assert.equal(
        result.outcome.status,
        expectedOutcome[result.expected],
        'Calibration accepted an incorrect outcome',
      );
    matched += Number(result.matched);
    totals[
      result.expected === 'passed'
        ? 'correct'
        : result.expected === 'failed'
          ? 'incorrect'
          : 'unsafe'
    ]++;
  }
  totals.cases += graded.results.length;
  totals.matched += matched;
  return {
    task: {
      id: task.id,
      domain: task.domain,
      split: task.split,
      role: task.role,
      calibrationCases: graded.results.length,
      calibrationMatched: matched,
      reviewStatus: status(receipt.status),
      submissionStatus: verification.outcome.status,
      adversarialChecks: review.adversarialChecks.length,
    },
    totals,
  };
}

/**
Read frozen calibration evidence only; never invokes a model, Grader or ledger.
*/
export async function readCalibrationPublication(
  evidenceRoot: string,
  expectedIndexHash: string,
): Promise<PublicBankCalibration> {
  assert.equal(await realpath(evidenceRoot), evidenceRoot);
  assertDigest(expectedIndexHash);
  const finalRoot = path.join(evidenceRoot, 'coordinator/final');
  const indexBytes = await readFile(
    path.join(finalRoot, 'evidence-index.json'),
  );
  assert.equal(
    digest(indexBytes),
    expectedIndexHash,
    'Calibration source index differs',
  );
  const index = JSON.parse(indexBytes.toString()) as {
    version: number;
    kind: string;
    bankId: string;
    pathBase: string;
    files: (Reference & { roles: string[] })[];
  };
  assert.equal(index.version, 1);
  assert.equal(index.kind, 'private-evidence-index');
  assert.equal(index.pathBase, 'reproduction root');
  assertDigest(index.bankId);
  const pinned = new Map<string, { sha256: string; bytes: Buffer }>();
  for (const reference of index.files) {
    assertDigest(reference.sha256);
    const file = path.resolve(evidenceRoot, reference.file);
    assert.equal(await realpath(file), file, 'Evidence path is aliased');
    assert.ok(!pinned.has(file), 'Duplicate calibration evidence');
    const bytes = await readFile(file);
    assert.equal(
      digest(bytes),
      reference.sha256,
      'Frozen calibration evidence changed',
    );
    pinned.set(file, { sha256: reference.sha256, bytes });
  }
  const read = <T>(reference: Reference): T => {
    const entry = pinned.get(path.resolve(evidenceRoot, reference.file));
    assert.ok(
      entry && entry.sha256 === reference.sha256,
      'Unindexed calibration reference',
    );
    return JSON.parse(entry.bytes.toString()) as T;
  };
  const finalReference = (name: string): Reference => {
    const file = path.join(finalRoot, name);
    const entry = pinned.get(file);
    assert.ok(entry, 'Final calibration aggregate is unindexed');
    return { file, sha256: entry.sha256 };
  };
  const suiteReference = finalReference('task-calibration.json');
  const suite = read<{
    version: number;
    kind: string;
    bankId: string;
    revision: string;
    status: CalibrationStatus;
    reviewerMode: string;
    referenceAccess: boolean;
    graderAccess: boolean;
    privateScoringFeedbackToReviewers: boolean;
    formalDispatchAuthorized: boolean;
    targetModelEvaluations: number;
    reviewers: number;
    additionalPublicInputAuditors: number;
    completedAt: number;
    taskExecutionRepeated: boolean;
    newBank: Reference;
    publicInputAudit: Reference;
    tasks: { id: string; status: CalibrationStatus; evidence: Reference }[];
    counts: {
      tasks: number;
      adversarialChecks: number;
      graderCalibrationCases: number;
      graderCalibrationMatched: number;
    };
  }>(suiteReference);
  assert.equal(suite.version, 2);
  assert.equal(suite.kind, 'independent-task-calibration-suite');
  assert.equal(suite.bankId, index.bankId);
  assert.equal(suite.reviewerMode, 'independent');
  assert.equal(
    suite.referenceAccess,
    false,
    'Review was exposed to a reference solution',
  );
  assert.equal(suite.graderAccess, false);
  assert.equal(suite.privateScoringFeedbackToReviewers, false);
  assert.equal(suite.formalDispatchAuthorized, false);
  assert.equal(
    suite.targetModelEvaluations,
    0,
    'Model results cannot be published as calibration',
  );
  const bank = read<{
    schemaVersion: number;
    revision: string;
    id: string;
    tasks: BankTask[];
  }>(suite.newBank);
  const { id, ...bankBody } = bank;
  assert.equal(id, contentIdentity(bankBody), 'Bank identity differs');
  assert.equal(id, suite.bankId);
  assert.equal(bank.schemaVersion, 1);
  assert.equal(bank.revision, suite.revision);
  assert.match(bank.revision, /^v\d+(?:\.\d+)?$/);
  assert.equal(bank.tasks.length, 26);
  assert.equal(
    suite.tasks.length,
    26,
    'Independent review inventory is incomplete',
  );
  assert.equal(new Set(suite.tasks.map((t) => t.id)).size, 26);
  const inputAudit = read<{
    summary: {
      equivalentCount: number;
      allEquivalentExcludingOnlyTopLevelBankId: boolean;
      sourcePacketsUnchangedAfterTests: boolean;
      bankIds: { new: string[] };
    };
  }>(suite.publicInputAudit);
  assert.equal(inputAudit.summary.equivalentCount, 26);
  assert.equal(
    inputAudit.summary.allEquivalentExcludingOnlyTopLevelBankId,
    true,
  );
  assert.equal(inputAudit.summary.sourcePacketsUnchangedAfterTests, true);
  assert.deepEqual(inputAudit.summary.bankIds.new, [id]);
  const calibrationReference = finalReference(
    'grader-calibration-summary.json',
  );
  const calibration = read<{
    bankId: string;
    tasks: number;
    cases: number;
    matched: number;
    modelCalls: number;
    classes: { passed: number; failed: number; unsafe: number };
  }>(calibrationReference);
  assert.equal(calibration.bankId, id);
  assert.equal(calibration.modelCalls, 0);
  const totals = { cases: 0, matched: 0, correct: 0, incorrect: 0, unsafe: 0 };
  const tasks: PublicBankCalibration['tasks'] = [];
  for (const task of bank.tasks) {
    const result = readTaskCalibration(
      task,
      suite.tasks.find((t) => t.id === task.id),
      id,
      read,
    );
    tasks.push(result.task);
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] += result.totals[key];
  }
  assert.equal(new Set(tasks.map((t) => t.id)).size, 26);
  const inventory = {
    tasks: tasks.length,
    development: tasks.filter((t) => t.split === 'dev').length,
    sealed: tasks.filter((t) => t.split === 'sealed').length,
    domains: new Set(
      tasks.filter((t) => t.role === 'main').map((t) => t.domain),
    ).size,
    negativeControls: tasks.filter((t) => t.role === 'negative-control').length,
  };
  assert.deepEqual(inventory, {
    tasks: 26,
    development: 17,
    sealed: 9,
    domains: 8,
    negativeControls: 2,
  });
  assert.equal(calibration.tasks, inventory.tasks);
  assert.equal(calibration.cases, totals.cases);
  assert.equal(calibration.matched, totals.matched);
  assert.deepEqual(calibration.classes, {
    passed: totals.correct,
    failed: totals.incorrect,
    unsafe: totals.unsafe,
  });
  assert.equal(suite.counts.tasks, tasks.length);
  assert.equal(suite.counts.graderCalibrationCases, totals.cases);
  assert.equal(suite.counts.graderCalibrationMatched, totals.matched);
  const adversarialChecks = tasks.reduce(
    (sum, t) => sum + t.adversarialChecks,
    0,
  );
  assert.equal(suite.counts.adversarialChecks, adversarialChecks);
  if (suite.status === 'passed')
    assert.ok(tasks.every((t) => t.reviewStatus === 'passed'));
  assert.equal(typeof suite.taskExecutionRepeated, 'boolean');
  assert.ok(Number.isFinite(suite.completedAt) && suite.completedAt > 0);
  assert.ok(count(suite.reviewers) > 0 && suite.reviewers <= tasks.length);
  const calculationSources = [];
  for (const name of [
    'export-evals-calibration.ts',
    'evals-public-protocol.ts',
  ]) {
    const bytes = await readFile(new URL(name, import.meta.url));
    calculationSources.push({ name, sha256: digest(bytes) });
  }
  const body: Omit<PublicBankCalibration, 'identity'> = {
    schemaVersion: 1,
    kind: 'task-bank-calibration',
    bankId: id,
    bankRevision: bank.revision,
    completedAt: new Date(suite.completedAt * 1000).toISOString(),
    scope: 'task-calibration',
    modelPerformanceIncluded: false,
    calculationIdentity: contentIdentity(calculationSources),
    sources: {
      indexSha256: expectedIndexHash,
      bankSha256: suite.newBank.sha256,
      reviewSha256: suiteReference.sha256,
      calibrationSha256: calibrationReference.sha256,
    },
    inventory,
    graderCalibration: totals,
    independentReview: {
      status: status(suite.status),
      reviewers: count(suite.reviewers),
      passed: tasks.filter((t) => t.reviewStatus === 'passed').length,
      adversarialChecks,
      referenceAccess: false,
      graderAccess: false,
      inputEquivalenceAuditors: count(suite.additionalPublicInputAuditors),
      equivalentInputs: inputAudit.summary.equivalentCount,
      taskExecutionRepeated: suite.taskExecutionRepeated,
    },
    tasks: tasks.toSorted((a, b) => a.id.localeCompare(b.id)),
  };
  return { ...body, identity: contentIdentity(body) };
}

export async function exportCalibration(
  evidenceRoot: string,
  sourceHash: string,
  output: string,
) {
  const data = await readCalibrationPublication(evidenceRoot, sourceHash);
  const target = path.resolve(output);
  assert.equal(path.basename(target), 'evals-latest-bank.json');
  assert.equal(await realpath(path.dirname(target)), path.dirname(target));
  const bytes = await format(JSON.stringify(data), { parser: 'json' });
  const archive = path.join(path.dirname(target), 'evals-calibrations');
  await mkdir(archive, { recursive: true });
  const frozen = path.join(archive, `${data.bankId}-${data.identity}.json`);
  try {
    await writeFile(frozen, bytes, { flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(frozen, 'utf8')) !== bytes
    )
      throw error;
  }
  const lock = target + '.lock';
  await mkdir(lock);
  try {
    const next = path.join(lock, 'next.json');
    await writeFile(next, bytes, { flag: 'wx' });
    await rename(next, target);
  } finally {
    await rm(lock, { recursive: true });
  }
  return data;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      'evidence-root': { type: 'string' },
      'source-index-sha256': { type: 'string' },
      output: { type: 'string' },
    },
  });
  assert.ok(
    values['evidence-root'] && values['source-index-sha256'] && values.output,
  );
  const data = await exportCalibration(
    values['evidence-root'],
    values['source-index-sha256'],
    values.output,
  );
  process.stdout.write(
    JSON.stringify({
      bankId: data.bankId,
      identity: data.identity,
      tasks: data.tasks.length,
    }) + '\n',
  );
}
