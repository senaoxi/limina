import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { contentIdentity } from './evals-public-protocol';
import type { publicTaskResult } from './export-evals-task';

type TaskResult = ReturnType<typeof publicTaskResult>;
type Measurements = TaskResult['measurements'];
type Average = Measurements['agentMs'];
interface Counts {
  passed: number;
  valid: number;
  planned: number;
  executions: number;
}
interface Condition extends Counts {
  measurements?: Measurements;
}
interface Task {
  id: string;
  domain: string;
  role: 'main' | 'negative-control';
  fixtureIdentity: string;
  gradingIdentity: string;
  executionIdentity?: string;
  conditions: Record<string, Condition>;
}
interface Source {
  campaignId: string;
  reportIdentity: string;
  sourceIndexDigest: string;
  bankId: string;
  bankRevision: string;
  stage: string;
  models: {
    status: string;
    profile: TaskResult['profile'];
    report: {
      complete: boolean;
      planned: number;
      executions: number;
      tasks: Task[];
    } | null;
  }[];
}
interface Reference {
  file: string;
  sha256: string;
}
export interface TaskRevisionSelection {
  kind: 'task-contract-revision';
  from: {
    bankId: string;
    fixtureIdentity: string;
    gradingIdentity: string;
    executionIdentity: string;
  };
  to: TaskRevisionSelection['from'];
}
const digest = (value: string) => assert.match(value, /^[a-f\d]{64}$/u);
const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const arms = ['base', 'skill'] as const;
const metrics = [
  'inputTokens',
  'agentMs',
  'endToEndMs',
  'apiEquivalentUsd',
  'settledUsd',
] as const;
const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
function counts(conditions: Condition[]): Counts {
  return conditions.reduce(
    (sum, condition) => ({
      passed: sum.passed + condition.passed,
      valid: sum.valid + condition.valid,
      planned: sum.planned + condition.planned,
      executions: sum.executions + condition.executions,
    }),
    { passed: 0, valid: 0, planned: 0, executions: 0 },
  );
}
function measurements(conditions: Condition[]): Measurements {
  return Object.fromEntries(
    metrics
      .filter(
        (metric) =>
          metric !== 'inputTokens' ||
          conditions.some((condition) => condition.measurements?.inputTokens),
      )
      .map((metric) => {
        const values = conditions.map((condition): Average => {
          const value = condition.measurements?.[metric];
          if (value) return value;
          return {
            mean: null,
            observedSum: 0,
            total: null,
            measured: 0,
            executions: condition.executions,
            coverage: 0,
            cells: 1,
            measuredCells: 0,
          };
        });
        const available = values.flatMap((value) =>
          value.mean === null ? [] : [value.mean],
        );
        const executions = values.reduce(
          (sum, value) => sum + value.executions,
          0,
        );
        const measured = values.reduce((sum, value) => sum + value.measured, 0);
        return [
          metric,
          {
            mean: available.length > 0 ? mean(available) : null,
            observedSum: values.reduce(
              (sum, value) => sum + value.observedSum,
              0,
            ),
            total:
              values.length > 0 && values.every((value) => value.total !== null)
                ? values.reduce((sum, value) => sum + value.total!, 0)
                : null,
            measured,
            executions,
            coverage: executions ? measured / executions : 0,
            cells: conditions.length,
            measuredCells: available.length,
          },
        ];
      }),
  ) as unknown as Measurements;
}

function verifyTaskRevision(
  source: Source,
  target: Task,
  latest: TaskResult,
  revision?: TaskRevisionSelection,
): void {
  assert.equal(target.fixtureIdentity, latest.fixtureIdentity);
  if (!revision) {
    assert.equal(target.gradingIdentity, latest.gradingIdentity);
    return;
  }
  assert.equal(source.stage, 'development');
  assert.equal(latest.taskId, 'I03');
  assert.equal(revision.kind, 'task-contract-revision');
  for (const value of [
    ...Object.values(revision.from),
    ...Object.values(revision.to),
  ])
    digest(value);
  assert.deepEqual(revision.from, {
    bankId: source.bankId,
    fixtureIdentity: target.fixtureIdentity,
    gradingIdentity: target.gradingIdentity,
    executionIdentity: target.executionIdentity,
  });
  assert.deepEqual(revision.to, {
    bankId: latest.bankId,
    fixtureIdentity: latest.fixtureIdentity,
    gradingIdentity: latest.gradingIdentity,
    executionIdentity: latest.executionIdentity,
  });
}

// This is an explicitly selected current-result view, never a new experiment.
export function buildCurrentSummary(
  source: Source,
  latest: TaskResult,
  references: { base: Reference; task: Reference },
  calculationIdentity: string,
  revision?: TaskRevisionSelection,
) {
  for (const value of [
    calculationIdentity,
    source.campaignId,
    source.reportIdentity,
    source.sourceIndexDigest,
    source.bankId,
    references.base.sha256,
    references.task.sha256,
  ])
    digest(value);
  assert.match(
    references.base.file,
    /^\.\/evals-campaigns\/[a-f\d-]+-(?:development|sealed)-[a-f\d]+\.json$/u,
  );
  assert.match(
    references.task.file,
    /^\.\/evals-task-results\/[a-f\d-]+\.json$/u,
  );
  const { identity, ...taskBody } = latest;
  assert.equal(
    contentIdentity(taskBody),
    identity,
    'Task result identity differs',
  );
  assert.equal(
    references.base.file,
    `./evals-campaigns/${source.campaignId}-${source.stage}-${source.reportIdentity}.json`,
  );
  assert.equal(
    references.task.file,
    `./evals-task-results/${latest.campaignId}-${identity}.json`,
  );
  assert.ok(['v2.1', 'v2.2'].includes(source.bankRevision));
  assert.equal(latest.bankRevision, source.bankRevision);
  assert.ok(['development', 'sealed'].includes(source.stage));
  assert.equal(latest.stage ?? 'sealed', source.stage);
  assert.equal(latest.kind, 'task-evaluation');
  assert.equal(latest.scope, 'task-condition');
  assert.equal(latest.complete, true);
  assert.equal(latest.condition, 'skill');
  assert.equal(source.models.length, 1);
  const model = source.models[0]!;
  assert.equal(model.status, 'recorded');
  for (const key of [
    'id',
    'model',
    'reasoningEffort',
    'serviceTier',
    'codexVersion',
  ] as const)
    assert.equal(
      model.profile[key],
      latest.profile[key],
      `Model ${key} differs`,
    );
  const original = model.report;
  assert.ok(original?.complete, 'A complete source batch is required');
  const tasks = structuredClone(original.tasks);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  const target = tasks.find((task) => task.id === latest.taskId);
  assert.ok(target && target.role === 'main');
  verifyTaskRevision(source, target, latest, revision);
  const previous = target.conditions.skill;
  assert.ok(previous);
  assert.equal(latest.counts.planned, previous.planned);
  assert.equal(latest.counts.valid, latest.counts.planned);
  assert.equal(latest.counts.executions, latest.counts.planned);
  assert.equal(latest.repetitions.length, latest.counts.planned);
  assert.deepEqual(
    latest.repetitions.map((r) => r.repetition).toSorted((a, b) => a - b),
    [1, 2, 3],
  );
  const terminal = new Set([
    'passed',
    'assertion_failed',
    'unsafe_mutation',
    'agent_error',
    'agent_timeout',
  ]);
  assert.ok(latest.repetitions.every((r) => terminal.has(r.status)));
  assert.equal(
    latest.counts.passed,
    latest.repetitions.filter((r) => r.status === 'passed').length,
  );
  const supersededExecutions = previous.executions;
  target.conditions.skill = {
    ...latest.counts,
    measurements: latest.measurements,
  };
  for (const task of tasks) {
    assert.match(task.id, /^[A-Z]\d{2}$/u);
    assert.match(task.domain, /^[a-z][a-z-]+$/u);
    for (const arm of arms) {
      const condition = task.conditions[arm];
      assert.ok(condition && condition.planned > 0);
      assert.equal(condition.valid, condition.planned);
      assert.ok(condition.executions >= condition.valid);
      assert.ok(
        Number.isSafeInteger(condition.passed) &&
          condition.passed >= 0 &&
          condition.passed <= condition.valid,
      );
    }
  }
  const main = tasks.filter((task) => task.role === 'main');
  const summarize = (group: Task[]) => {
    const selected = (arm: string) =>
      group.map((task) => task.conditions[arm]!);
    const conditionCounts = Object.fromEntries(
      arms.map((arm) => [arm, counts(selected(arm))]),
    );
    const rates = Object.fromEntries(
      arms.map((arm) => [
        arm,
        mean(selected(arm).map((c) => c.passed / c.valid)),
      ]),
    );
    return {
      counts: conditionCounts,
      conditions: rates,
      differencePercentagePoints: 100 * (rates.skill! - rates.base!),
    };
  };
  const domains = [...new Set(main.map((task) => task.domain))].map((id) => {
    const members = main.filter((task) => task.domain === id);
    return { id, taskCount: members.length, ...summarize(members) };
  });
  assert.ok(domains.length);
  const macro = Object.fromEntries(
    arms.map((arm) => [arm, mean(domains.map((d) => d.conditions[arm]!))]),
  );
  const measuredGroup = (group: Task[]) => ({
    all: measurements(
      group.flatMap((task) => arms.map((arm) => task.conditions[arm]!)),
    ),
    conditions: Object.fromEntries(
      arms.map((arm) => [
        arm,
        measurements(group.map((task) => task.conditions[arm]!)),
      ]),
    ),
  });
  const selectedExecutions = tasks
    .flatMap((task) => arms.map((arm) => task.conditions[arm]!))
    .reduce((sum, c) => sum + c.executions, 0);
  assert.equal(
    selectedExecutions,
    original.executions - supersededExecutions + latest.counts.executions,
  );
  const hasInputTokens = tasks.some((task) =>
    arms.some((arm) => task.conditions[arm]?.measurements?.inputTokens),
  );
  const body = {
    schemaVersion: revision ? 3 : hasInputTokens ? 2 : 1,
    kind: 'current-task-summary',
    policy: 'latest-complete-task-condition',
    calculationIdentity,
    bankRevision: source.bankRevision,
    stage: source.stage,
    modelProfileId: model.profile.id,
    ...(revision && {
      revision: {
        kind: revision.kind,
        from: { ...revision.from },
        to: { ...revision.to },
      },
    }),
    sources: {
      base: {
        file: references.base.file,
        sha256: references.base.sha256,
        campaignId: source.campaignId,
        reportIdentity: source.reportIdentity,
        bankId: source.bankId,
        sourceIndexDigest: source.sourceIndexDigest,
      },
      task: {
        file: references.task.file,
        sha256: references.task.sha256,
        identity,
        campaignId: latest.campaignId,
        reportIdentity: latest.reportIdentity,
        bankId: latest.bankId,
        experimentIdentity: latest.experimentIdentity,
        sourceIndexSha256: latest.sourceIndexSha256,
        taskId: latest.taskId,
        condition: latest.condition,
        ...(revision && {
          fixtureIdentity: latest.fixtureIdentity,
          gradingIdentity: latest.gradingIdentity,
          executionIdentity: latest.executionIdentity,
        }),
      },
    },
    selectedExecutions,
    sourceExecutions: original.executions + latest.counts.executions,
    supersededExecutions,
    counts: summarize(main).counts,
    macro,
    differencePercentagePoints: 100 * (macro.skill! - macro.base!),
    domains,
    measurements: {
      main: measuredGroup(main),
      negativeControls: measuredGroup(
        tasks.filter((task) => task.role === 'negative-control'),
      ),
    },
    ...(hasInputTokens && {
      tasks: tasks.map((task) => ({
        id: task.id,
        measurements: measurements(arms.map((arm) => task.conditions[arm]!)),
      })),
    }),
  };
  return { ...body, identity: contentIdentity(body) };
}

export async function exportCurrentSummary(inputs: {
  baseFile: string;
  baseSha256: string;
  taskFile: string;
  taskSha256: string;
  revision?: TaskRevisionSelection;
}) {
  const root = fileURLToPath(
    new URL('../../docs/.vitepress/theme/', import.meta.url),
  );
  const [baseBytes, taskBytes] = await Promise.all([
    readFile(inputs.baseFile),
    readFile(inputs.taskFile),
  ]);
  assert.equal(sha256(baseBytes), inputs.baseSha256);
  assert.equal(sha256(taskBytes), inputs.taskSha256);
  const reference = (file: string, digest: string) => ({
    file: './' + path.relative(root, file).split(path.sep).join('/'),
    sha256: digest,
  });
  const implementationBytes = await readFile(fileURLToPath(import.meta.url));
  const protocolFile = fileURLToPath(
    new URL('evals-public-protocol.ts', import.meta.url),
  );
  const protocolBytes = await readFile(protocolFile);
  const calculationIdentity = contentIdentity({
    implementation: sha256(implementationBytes),
    protocol: sha256(protocolBytes),
  });
  const latest = JSON.parse(taskBytes.toString()) as TaskResult;
  assert.match(latest.profile.model, /^[a-z\d][a-z\d.-]{1,80}$/u);
  const result = buildCurrentSummary(
    JSON.parse(baseBytes.toString()) as Source,
    latest,
    {
      base: reference(inputs.baseFile, inputs.baseSha256),
      task: reference(inputs.taskFile, inputs.taskSha256),
    },
    calculationIdentity,
    inputs.revision,
  );
  const bytes = await format(JSON.stringify(result), { parser: 'json' });
  const snapshots = path.join(root, 'evals-current-summaries');
  await mkdir(snapshots, { recursive: true });
  const snapshot = path.join(snapshots, result.identity + '.json');
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
    latest.profile.model === 'gpt-6.1-terra' ? '' : `-${latest.profile.model}`;
  const target = path.join(
    root,
    result.sources.task.taskId === 'I03'
      ? `evals-current-i03${modelSuffix}-results.json`
      : 'evals-current-results.json',
  );
  const lock = target + '.lock';
  await mkdir(lock);
  try {
    await writeFile(path.join(lock, 'next.json'), bytes, { flag: 'wx' });
    await rename(path.join(lock, 'next.json'), target);
  } finally {
    await rm(lock, { recursive: true });
  }
  return result;
}
