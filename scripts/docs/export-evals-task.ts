import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { contentIdentity } from './evals-public-protocol';
import { readCampaignPublication } from './export-evals-campaign';

interface Average {
  mean: number | null;
  observedSum: number;
  total: number | null;
  measured: number;
  executions: number;
  coverage: number;
  cells: number;
  measuredCells: number;
}
interface Measurements {
  inputTokens?: Average;
  agentMs: Average;
  endToEndMs: Average;
  apiEquivalentUsd: Average;
  settledUsd: Average;
}
interface TaskSource {
  schemaVersion: number;
  campaignId: string;
  reportIdentity: string;
  bankId: string;
  bankRevision: string;
  stage: string;
  models: {
    status: string;
    profile: {
      id: string;
      model: string;
      displayName: string;
      reasoningEffort: string;
      serviceTier: string;
      codexVersion: string;
    };
    report: {
      experimentIdentity: string;
      planned: number;
      executions: number;
      tasks: {
        id: string;
        fixtureIdentity: string;
        gradingIdentity: string;
        executionIdentity: string;
        conditions: Record<
          string,
          {
            passed: number;
            valid: number;
            planned: number;
            coverage: number;
            executions: number;
            measurements: Measurements;
            repetitions: {
              repetition: number;
              status: string;
              attemptCount: number;
              attempts: { id: string; ordinal: number; status: string }[];
            }[];
          }
        >;
      }[];
    } | null;
  }[];
}
const digest = (value: string) => assert.match(value, /^[a-f\d]{64}$/u);
const terminal = new Set([
  'passed',
  'assertion_failed',
  'unsafe_mutation',
  'agent_error',
  'agent_timeout',
]);
function average(value: Average) {
  for (const n of [value.mean, value.total, value.observedSum])
    assert.ok(n === null || (Number.isFinite(n) && n >= 0));
  for (const n of [
    value.measured,
    value.executions,
    value.cells,
    value.measuredCells,
  ])
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  assert.equal(value.executions, 3);
  assert.ok(value.measured <= 3 && value.measuredCells <= value.cells);
  assert.equal(value.coverage, value.measured / 3);
  return {
    mean: value.mean,
    observedSum: value.observedSum,
    total: value.total,
    measured: value.measured,
    executions: value.executions,
    coverage: value.coverage,
    cells: value.cells,
    measuredCells: value.measuredCells,
  };
}

// This view has its own one-task scope. It cannot replace a full-bank score.
export function publicTaskResult(
  source: TaskSource,
  sourceIndexSha256: string,
  selection?: { taskId: 'P03' | 'I03' },
) {
  const taskId = selection?.taskId ?? 'P03';
  digest(sourceIndexSha256);
  assert.equal(source.schemaVersion, 2);
  for (const id of [source.campaignId, source.reportIdentity, source.bankId])
    digest(id);
  assert.ok(['v2.1', 'v2.2'].includes(source.bankRevision));
  assert.ok(['P03', 'I03'].includes(taskId));
  const stage = taskId === 'I03' ? 'development' : 'sealed';
  assert.equal(source.stage, stage);
  assert.equal(source.models.length, 1);
  const model = source.models[0]!;
  assert.equal(model.status, 'recorded');
  const report = model.report;
  assert.ok(report);
  digest(report.experimentIdentity);
  digest(model.profile.id);
  assert.match(model.profile.model, /^[a-z\d][a-z\d.-]{1,80}$/u);
  assert.match(model.profile.displayName, /^[\w .()-]{1,100}$/u);
  assert.match(model.profile.codexVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(model.profile.reasoningEffort, 'high');
  assert.equal(model.profile.serviceTier, 'default');
  assert.equal(report.planned, stage === 'development' ? 102 : 54);
  assert.equal(report.executions, 3);
  const task = report.tasks.find((entry) => entry.id === taskId);
  assert.ok(task);
  for (const id of [
    task.fixtureIdentity,
    task.gradingIdentity,
    task.executionIdentity,
  ])
    digest(id);
  const condition = task.conditions.skill;
  assert.ok(condition);
  assert.equal(condition.planned, 3);
  assert.equal(condition.executions, 3);
  assert.equal(condition.valid, 3);
  assert.equal(condition.coverage, 1);
  assert.equal(
    report.tasks
      .flatMap((entry) => Object.values(entry.conditions))
      .reduce((sum, entry) => sum + entry.executions, 0),
    3,
  );
  const repetitions = condition.repetitions.toSorted(
    (a, b) => a.repetition - b.repetition,
  );
  assert.deepEqual(
    repetitions.map((entry) => entry.repetition),
    [1, 2, 3],
  );
  const attemptIds = new Set<string>();
  for (const entry of repetitions) {
    assert.ok(terminal.has(entry.status), 'Unresolved task result');
    assert.equal(entry.attemptCount, 1);
    assert.equal(entry.attempts.length, 1);
    const attempt = entry.attempts[0]!;
    digest(attempt.id);
    assert.equal(attempt.ordinal, 1);
    assert.equal(attempt.status, entry.status);
    attemptIds.add(attempt.id);
  }
  assert.equal(attemptIds.size, 3);
  assert.equal(
    condition.passed,
    repetitions.filter((entry) => entry.status === 'passed').length,
  );
  const body = {
    schemaVersion:
      taskId === 'I03' ? 3 : condition.measurements.inputTokens ? 2 : 1,
    ...(taskId === 'I03' && { stage }),
    kind: 'task-evaluation',
    scope: 'task-condition',
    includedInFormalScores: false,
    complete: true,
    bankId: source.bankId,
    bankRevision: source.bankRevision,
    campaignId: source.campaignId,
    experimentIdentity: report.experimentIdentity,
    reportIdentity: source.reportIdentity,
    sourceIndexSha256,
    taskId,
    condition: 'skill',
    fixtureIdentity: task.fixtureIdentity,
    gradingIdentity: task.gradingIdentity,
    executionIdentity: task.executionIdentity,
    profile: {
      id: model.profile.id,
      model: model.profile.model,
      displayName: model.profile.displayName,
      reasoningEffort: model.profile.reasoningEffort,
      serviceTier: model.profile.serviceTier,
      codexVersion: model.profile.codexVersion,
    },
    counts: { passed: condition.passed, valid: 3, planned: 3, executions: 3 },
    measurements: {
      ...(condition.measurements.inputTokens && {
        inputTokens: average(condition.measurements.inputTokens),
      }),
      agentMs: average(condition.measurements.agentMs),
      endToEndMs: average(condition.measurements.endToEndMs),
      apiEquivalentUsd: average(condition.measurements.apiEquivalentUsd),
      settledUsd: average(condition.measurements.settledUsd),
    },
    repetitions: repetitions.map((entry) => ({
      repetition: entry.repetition,
      status: entry.status,
    })),
  };
  return { ...body, identity: contentIdentity(body) };
}

export async function exportTaskResult(
  directory: string,
  expectedHash: string,
  selection?: { taskId: 'P03' | 'I03' },
) {
  const source = await readCampaignPublication(directory, expectedHash);
  const data = publicTaskResult(
    source as unknown as TaskSource,
    expectedHash,
    selection,
  );
  const publicRoot = fileURLToPath(
    new URL('../../docs/.vitepress/theme/', import.meta.url),
  );
  const output = path.join(publicRoot, 'evals-task-results');
  await mkdir(output, { recursive: true });
  const bytes = await format(JSON.stringify(data), { parser: 'json' });
  const snapshot = path.join(
    output,
    `${data.campaignId}-${data.identity}.json`,
  );
  try {
    await writeFile(snapshot, bytes, { flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(snapshot, 'utf8')) !== bytes
    )
      throw error;
  }
  const modelSuffix =
    data.profile.model === 'gpt-6.1-terra' ? '' : `-${data.profile.model}`;
  const target = path.join(
    publicRoot,
    data.taskId === 'I03'
      ? `evals-i03${modelSuffix}-task-result.json`
      : 'evals-task-result.json',
  );
  const lock = target + '.lock';
  await mkdir(lock);
  try {
    await writeFile(path.join(lock, 'next.json'), bytes, { flag: 'wx' });
    await rename(path.join(lock, 'next.json'), target);
  } finally {
    await rm(lock, { recursive: true });
  }
  return data;
}
