import { captureRoots } from './capture-policy.ts';
import { contentIdentity } from './identity.ts';
import {
  assertDigest,
  type ModelProfile,
  verifyModelProfile,
} from './model-profile.ts';
import { type TaskBankRevision, verifyTaskBank } from './task-bank.ts';
import type { Domain, TaskSpec } from './task.ts';

export type ConditionId = 'base' | 'skill' | 'candidate' | 'explicit-skill';
export type BatchKind =
  | 'smoke'
  | 'pilot'
  | 'development'
  | 'sealed'
  | 'confirmation';

const domains: [string, Domain][] = [
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

/**
Public inventory only. Sealed task text, graders and results are controller data.
*/
export const taskCatalog = domains.flatMap(([prefix, domain]) =>
  Array.from({ length: prefix === 'N' ? 2 : 3 }, (_, index) => {
    const id = `${prefix}0${index + 1}`;
    return {
      id,
      domain,
      split: sealedIds.has(id) ? ('sealed' as const) : ('dev' as const),
    };
  }),
);

export interface FrozenTask {
  id: string;
  domain: Domain;
  split: 'dev' | 'sealed';
  specDigest: string;
  executionDigest: string;
  gradingDigest: string;
}

export function freezeTaskIdentity(
  task: TaskSpec,
  setupDigest: string,
  gradingToolchainDigest: string,
): FrozenTask {
  captureRoots(task);
  digest(setupDigest);
  digest(gradingToolchainDigest);
  const catalog = taskCatalog.find((entry) => entry.id === task.id);
  if (
    !catalog ||
    catalog.domain !== task.domain ||
    catalog.split !== task.split
  )
    throw new Error('Task does not match the frozen inventory');
  const { gradingContract, ...execution } = task;
  return {
    ...catalog,
    specDigest: contentIdentity(task),
    executionDigest: contentIdentity({ execution, setupDigest }),
    gradingDigest: contentIdentity({
      gradingContract,
      capturePolicy: task.capturePolicy,
      mutationPolicy: task.mutationPolicy,
      dependencyPolicy: task.dependencyPolicy,
      installPlan: task.installPlan,
      gradingToolchainDigest,
    }),
  };
}

export interface ExperimentInputs {
  kind: BatchKind;
  seed: string;
  preparedInputsDigest: string;
  runnerDigest: string;
  toolchainDigest: string;
  contextDigest: string;
  imageDigest: string;
  tasks: FrozenTask[];
  conditions: { id: ConditionId; skillDigest: string | null }[];
  modelProfile?: ModelProfile;
  bank?: TaskBankRevision;
  campaignId?: string;
  commonContractId?: string;
}

export interface ExperimentSlot {
  id: string;
  block: string;
  taskId: string;
  repetition: number;
  condition: ConditionId;
  executionIdentity: string;
  gradingIdentity: string;
  comparisonIdentity: string;
  modelProfileId?: string;
  designCellId?: string;
}

export interface ExperimentManifest {
  version: 1 | 2;
  identity: string;
  inputs: ExperimentInputs;
  policy: {
    model: string;
    reasoningEffort: string;
    speed?: 'standard';
    serviceTier?: 'default';
    modelProfileId?: string;
    authentication: 'chatgpt';
    backend: 'local-native-sandbox';
    concurrency: 1;
    repetitions: 1 | 3;
    maximumInfrastructureRetries: 1;
    timeoutsMs: {
      setup: 600_000;
      agent: 900_000;
      grading: 300_000;
      capture: 120_000;
    };
    budget: { currency: 'USD'; totalLimit: 100; reserve: 15 };
  };
  slots: ExperimentSlot[];
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))
    throw new Error('Experiment requires a SHA-256 input identity');
}

function expectedTasksForBatch(kind: ExperimentInputs['kind']) {
  return kind === 'smoke'
    ? taskCatalog.filter((task) => task.id === 'I01')
    : taskCatalog.filter((task) =>
        kind === 'pilot'
          ? [
              'I01',
              'C01',
              'R02',
              'K01',
              'S01',
              'W02',
              'T01',
              'P01',
              'N01',
            ].includes(task.id)
          : kind === 'confirmation' ||
            task.split === (kind === 'development' ? 'dev' : 'sealed'),
      );
}

function validateInputs(inputs: ExperimentInputs): void {
  if (
    !['smoke', 'pilot', 'development', 'sealed', 'confirmation'].includes(
      inputs.kind,
    ) ||
    !inputs.seed ||
    (inputs.kind === 'pilot' && !inputs.modelProfile)
  )
    throw new Error('Unknown batch kind or missing randomization seed');
  for (const value of [
    inputs.preparedInputsDigest,
    inputs.runnerDigest,
    inputs.toolchainDigest,
    inputs.contextDigest,
    inputs.imageDigest,
  ])
    digest(value);
  const requiredConditions: ConditionId[] =
    inputs.kind === 'smoke'
      ? ['base', 'skill', 'explicit-skill']
      : inputs.kind === 'confirmation'
        ? ['base', 'skill', 'candidate']
        : ['base', 'skill'];
  if (
    inputs.conditions.length !== requiredConditions.length ||
    requiredConditions.some(
      (id) =>
        inputs.conditions.filter((condition) => condition.id === id).length !==
        1,
    )
  )
    throw new Error('Conditions do not match the preregistered batch');
  for (const condition of inputs.conditions) {
    if (condition.id === 'base') {
      if (condition.skillDigest !== null)
        throw new Error('Base must have no Skill');
    } else digest(condition.skillDigest);
  }
  if (
    inputs.kind === 'smoke' &&
    inputs.conditions.find((condition) => condition.id === 'skill')
      ?.skillDigest !==
      inputs.conditions.find((condition) => condition.id === 'explicit-skill')
        ?.skillDigest
  )
    throw new Error('Explicit smoke must use the same current Skill');
  const expectedTasks = expectedTasksForBatch(inputs.kind);
  if (
    inputs.tasks.length !== expectedTasks.length ||
    expectedTasks.some(
      (expected) =>
        inputs.tasks.filter(
          (task) =>
            task.id === expected.id &&
            task.domain === expected.domain &&
            task.split === expected.split,
        ).length !== 1,
    )
  )
    throw new Error('Incomplete or altered preregistered task inventory');
  for (const task of inputs.tasks) {
    digest(task.specDigest);
    digest(task.executionDigest);
    digest(task.gradingDigest);
  }
}

/**
Freeze all slots up front. A successful result never removes later repetitions.
*/
export function createExperiment(inputs: ExperimentInputs): ExperimentManifest {
  validateInputs(inputs);
  const policy: ExperimentManifest['policy'] = {
    model: 'gpt-6.1-terra',
    reasoningEffort: 'high',
    speed: 'standard',
    authentication: 'chatgpt',
    backend: 'local-native-sandbox',
    concurrency: 1,
    repetitions: inputs.kind === 'smoke' || inputs.kind === 'pilot' ? 1 : 3,
    maximumInfrastructureRetries: 1,
    timeoutsMs: {
      setup: 600_000,
      agent: 900_000,
      grading: 300_000,
      capture: 120_000,
    },
    budget: { currency: 'USD', totalLimit: 100, reserve: 15 },
  };
  const profile = inputs.modelProfile;
  const version = profile ? (2 as const) : (1 as const);
  if (profile) {
    verifyModelProfile(profile);
    if (!inputs.bank || !inputs.campaignId || !inputs.commonContractId)
      throw new Error('V2 requires a frozen bank and campaign');
    verifyTaskBank(inputs.bank);
    assertDigest(inputs.campaignId);
    assertDigest(inputs.commonContractId);
    for (const task of inputs.tasks)
      if (
        inputs.bank.tasks.every(
          (t) =>
            !(
              t.id === task.id &&
              t.specDigest === task.specDigest &&
              t.executionDigest === task.executionDigest &&
              t.gradingDigest === task.gradingDigest
            ),
        )
      )
        throw new Error('Experiment task differs from bank');
    delete policy.speed;
    policy.model = profile.canonicalModelId;
    policy.reasoningEffort = profile.reasoningEffort;
    policy.serviceTier = profile.requestedServiceTier;
    policy.modelProfileId = profile.id;
  } else if (inputs.bank || inputs.campaignId || inputs.commonContractId)
    throw new Error('Partial model identity');
  const identity = contentIdentity({ version, inputs, policy });
  const common = {
    preparedInputsDigest: inputs.preparedInputsDigest,
    runnerDigest: inputs.runnerDigest,
    toolchainDigest: inputs.toolchainDigest,
    contextDigest: inputs.contextDigest,
    imageDigest: inputs.imageDigest,
    policy,
  };
  const slots: ExperimentSlot[] = [];
  for (const task of inputs.tasks) {
    for (let repetition = 1; repetition <= policy.repetitions; repetition++) {
      const block = `${task.id}:${repetition}`;
      const ordered = inputs.conditions
        .map((condition) => ({
          condition,
          order: contentIdentity({
            seed: inputs.seed,
            block,
            condition: condition.id,
          }),
        }))
        .toSorted((a, b) =>
          Buffer.compare(Buffer.from(a.order), Buffer.from(b.order)),
        );
      for (const { condition } of ordered) {
        const execution = {
          common,
          task: task.executionDigest,
          activation:
            condition.id === 'explicit-skill' ? 'explicit' : 'natural',
        };
        const gradingIdentity = contentIdentity({
          task: task.gradingDigest,
          imageDigest: inputs.imageDigest,
          toolchainDigest: inputs.toolchainDigest,
        });
        slots.push({
          id: contentIdentity({ identity, block, condition: condition.id }),
          block,
          taskId: task.id,
          repetition,
          condition: condition.id,
          executionIdentity: contentIdentity({
            ...execution,
            skillDigest: condition.skillDigest,
          }),
          gradingIdentity,
          ...(profile && {
            modelProfileId: profile.id,
            designCellId: contentIdentity({
              campaignId: inputs.campaignId,
              commonContractId: inputs.commonContractId,
              bankId: inputs.bank!.id,
              task: task.executionDigest,
              gradingIdentity,
              repetition,
              kind: inputs.kind,
            }),
          }),
          comparisonIdentity: contentIdentity({
            ...execution,
            gradingIdentity,
          }),
        });
      }
    }
  }
  if (profile) {
    const taskOrder = inputs.tasks.toSorted((a, b) =>
      contentIdentity({ seed: inputs.seed, task: a.id }).localeCompare(
        contentIdentity({ seed: inputs.seed, task: b.id }),
      ),
    );
    const conditions = [...inputs.conditions].toSorted((a, b) =>
      a.id.localeCompare(b.id),
    );
    const blocks = taskOrder
      .flatMap((task, index) =>
        Array.from({ length: policy.repetitions }, (_, r) => ({
          task,
          repetition: r + 1,
          index: r * taskOrder.length + index,
        })),
      )
      .toSorted((a, b) => a.index - b.index);
    const reordered = blocks.flatMap((b) => {
      const rotation = b.index % conditions.length;
      return [
        ...conditions.slice(rotation),
        ...conditions.slice(0, rotation),
      ].map(
        (c) =>
          slots.find(
            (s) =>
              s.taskId === b.task.id &&
              s.repetition === b.repetition &&
              s.condition === c.id,
          )!,
      );
    });
    slots.splice(0, slots.length, ...reordered);
  }
  return {
    version,
    identity,
    inputs: structuredClone(inputs),
    policy,
    slots,
  };
}

export function verifyExperiment(manifest: ExperimentManifest): void {
  const rebuilt = createExperiment(manifest.inputs);
  if (contentIdentity(rebuilt) !== contentIdentity(manifest))
    throw new Error('Experiment manifest or slot identity changed');
}
