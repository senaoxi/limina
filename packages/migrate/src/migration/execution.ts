import {
  configContextPath,
  type ResolvedLiminaInputs,
} from 'limina/internal/config/runner';
import type { DependencyAnalysisResult } from 'limina/internal/core/build-graph/types';
import type { LiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { MigrationLogger } from 'limina/internal/logger';
import { readFile } from 'node:fs/promises';
import type { MigrationRecord } from './declarations';
import {
  createExecutionState,
  executeGroups,
  type MigrationExecutionState,
  prepareGroups,
} from './execution-groups';
import { collectMigrationWorktreeRoots } from './git';
import {
  confirmDirtyWorkspaceChanges,
  decideHardlinkPolicy,
  type MigrationTask,
} from './interactions';
import { createFrozenMigrationPlan, type FrozenMigrationPlan } from './planner';
import { failureRecords, publishFailure, publishReport } from './report';
import {
  assertMigrationScopeUnchanged,
  governanceBinding,
  type MigrationConfigSource,
  migrationInputSource,
} from './scope';
import type { PreparedMigrationPlan } from './transaction';
import { assertUniquePhysicalTargets } from './transaction/cleanup';
import type {
  RunMigrationImplResult,
  RunMigrationOptions,
  RunMigrationResult,
} from './types';
import {
  type MigrationDiskVerification,
  verifyMigrationFromDisk,
} from './verification';
import { showWriteDecisions, showWritePlan } from './write-plan';

async function assertPlanningInputsUnchanged(
  plan: FrozenMigrationPlan,
): Promise<void> {
  for (const [file, content] of plan.inputs) {
    if ((await readFile(file, 'utf8')) !== content)
      throw new Error(
        `Migration planning input changed before writing: ${file}`,
      );
  }
}
function previewStatus(
  plan: FrozenMigrationPlan,
  isDryRun: boolean | undefined,
): Pick<RunMigrationResult, 'outcome' | 'previewComplete'> {
  if (!isDryRun) return { outcome: 'applied' };
  return {
    outcome: 'preview',
    previewComplete: !plan.incomplete && plan.topology.sources.length > 0,
  };
}
function createResult(options: {
  config: ResolvedLiminaInputs;
  plan: FrozenMigrationPlan;
  state: MigrationExecutionState;
  verification: MigrationDiskVerification;
  source: MigrationConfigSource;
  verificationSource?: MigrationConfigSource;
  dryRun?: boolean;
}): RunMigrationResult {
  const { config, plan, state, verification } = options;
  const analysis = readAnalysis(plan.records);
  if (plan.incomplete) state.incompleteFiles.push(configContextPath(config));
  return {
    ...previewStatus(plan, options.dryRun),
    inputSource: options.source,
    verificationSource: options.verificationSource,
    checkerEntryCount: plan.topology.entries.length,
    hardlinkRewrittenFiles: state.execution.hardlinkRewrittenFiles,
    hardlinkSkippedFiles: state.execution.hardlinkSkippedFiles,
    modifiedFiles: state.execution.modifiedFiles,
    recursiveReferenceCount: Math.max(
      0,
      plan.topology.sources.length +
        plan.topology.solutions.length -
        plan.topology.entries.length,
    ),
    rootDir: config.rootDir,
    skippedFiles: state.execution.skippedFiles,
    processingComplete: true,
    inputConsumable:
      verification.consumable && state.incompleteFiles.length === 0,
    incompleteFiles: [...new Set(state.incompleteFiles)],
    comparisonComplete: analysis.complete,
    analysisDiagnostics: analysis.diagnostics,
    isolatedFiles: plan.records
      .filter((record) => record.kind === 'isolated')
      .map((record) => record.configPath),
    outsideReferenceCount: plan.records.filter(
      (record) =>
        record.kind === 'removed-native-reference' &&
        record.message === 'outside activated config topology',
    ).length,
    failedGroups: plan.records.filter((record) =>
      [
        'write-preflight-failed',
        'write-group-restored',
        'write-group-skipped',
      ].includes(record.kind),
    ).length,
  };
}
function readAnalysis(
  records: readonly MigrationRecord[],
): DependencyAnalysisResult {
  const record = records.find((item) => item.kind === 'dependency-analysis');
  return record
    ? (record.details as DependencyAnalysisResult)
    : { complete: false, diagnostics: [], facts: [] };
}
interface ExecutionContext {
  config: ResolvedLiminaInputs;
  namespace: LiminaArtifactNamespace;
  runOptions: RunMigrationOptions;
  task: MigrationTask;
  source: MigrationConfigSource;
  rootBinding: string;
}
function verificationSource(
  plan: FrozenMigrationPlan,
  source: MigrationConfigSource,
): MigrationConfigSource {
  const created = plan.groups
    .flat()
    .find((item) => item.operation === 'create');
  return created
    ? { kind: 'file', configPath: created.configPath, discovery: 'ancestor' }
    : source;
}
function skippedHardlinkDecisions(
  prepared: PreparedMigrationPlan[],
  hardlinkPolicy: string,
): string[] {
  return hardlinkPolicy === 'skip'
    ? prepared
        .filter((group) => group.hardlinkSnapshots.length > 0)
        .map(
          (group) =>
            `skipped consistency group (hardlink policy): ${[...group.createSnapshots, ...group.atomicSnapshots, ...group.hardlinkSnapshots].map((snapshot) => snapshot.item.configPath).join(', ')}`,
        )
    : [];
}
function reportWriteDecisions(
  context: ExecutionContext,
  input: {
    state: MigrationExecutionState;
    prepared: PreparedMigrationPlan[];
    hardlinkPolicy: string;
  },
): void {
  showWriteDecisions(context.runOptions, [
    ...input.state.records
      .filter((record) => record.kind === 'write-preflight-failed')
      .map(
        (record) =>
          `blocked: ${JSON.stringify(record.details)} — ${record.message}`,
      ),
    ...skippedHardlinkDecisions(input.prepared, input.hardlinkPolicy),
  ]);
}
async function assertWriteInputs(
  context: ExecutionContext,
  plan: FrozenMigrationPlan,
): Promise<void> {
  if (context.runOptions.scope)
    assertMigrationScopeUnchanged(context.runOptions.scope);
  await assertPlanningInputsUnchanged(plan);
}
async function runApplied(
  context: ExecutionContext,
  plan: FrozenMigrationPlan,
  state: MigrationExecutionState,
): Promise<RunMigrationImplResult> {
  const roots = [
    ...new Set(await collectMigrationWorktreeRoots(plan.groups.flat())),
  ];
  // Freeze physical snapshots before any mutation. Analysis never resumes after writing.
  const prepared = await prepareGroups({ plan, roots, state });
  assertUniquePhysicalTargets(
    prepared.flatMap((group) => [
      ...group.atomicSnapshots,
      ...group.hardlinkSnapshots,
    ]),
  );
  await confirmDirtyWorkspaceChanges({ roots, ...context });
  const hardlinkPolicy = await decideHardlinkPolicy({
    configRootDir: context.config.rootDir,
    hardlinkConfigPaths: prepared.flatMap((group) =>
      group.hardlinkSnapshots.map((snapshot) => snapshot.item.configPath),
    ),
    ...context,
  });
  reportWriteDecisions(context, { prepared, hardlinkPolicy, state });
  await assertWriteInputs(context, plan);
  await executeGroups({ prepared, hardlinkPolicy, state });
  const source = verificationSource(plan, context.source);
  const verification = await verifyMigrationFromDisk(
    context.config,
    plan.topology,
    {
      ...context.runOptions,
      verificationSource: source,
      rootBinding: context.rootBinding,
    },
  );
  const result = createResult({
    ...context,
    plan,
    state,
    verification,
    verificationSource: source,
  });
  await publishReport({ ...context, plan, verification, result });
  for (const diagnostic of verification.diagnostics)
    MigrationLogger.warn(diagnostic);
  return { cleanupWarnings: state.execution.cleanupWarnings, result };
}
function previewResult(
  context: ExecutionContext,
  plan: FrozenMigrationPlan,
  state: MigrationExecutionState,
): RunMigrationImplResult {
  return {
    cleanupWarnings: [],
    result: createResult({
      ...context,
      plan,
      state,
      dryRun: true,
      verification: { consumable: false, diagnostics: [], topologies: [] },
    }),
  };
}
async function reportFailure(
  context: ExecutionContext,
  plan: FrozenMigrationPlan | undefined,
  error: unknown,
): Promise<void> {
  if (!context.runOptions.dryRun) {
    await publishFailure({ ...context, plan, error });
    return;
  }
  const messages = failureRecords({ plan, error })
    .filter((record) => record.message)
    .map(
      (record) => `${record.kind}: ${record.configPath} — ${record.message}`,
    );
  showWriteDecisions(context.runOptions, messages);
}
export async function runMigrationImpl(
  config: ResolvedLiminaInputs,
  namespace: LiminaArtifactNamespace,
  options: { runOptions: RunMigrationOptions; task: MigrationTask },
): Promise<RunMigrationImplResult> {
  const context = createExecutionContext(config, namespace, options);
  let plan: FrozenMigrationPlan | undefined;
  try {
    plan = await createFrozenMigrationPlan(config, namespace);
    showWritePlan(plan, config.rootDir, context.runOptions);
    const state = createExecutionState(plan);
    return context.runOptions.dryRun
      ? previewResult(context, plan, state)
      : await runApplied(context, plan, state);
  } catch (error) {
    await reportFailure(context, plan, error);
    throw error;
  }
}

function createExecutionContext(
  config: ResolvedLiminaInputs,
  namespace: LiminaArtifactNamespace,
  options: { runOptions: RunMigrationOptions; task: MigrationTask },
): ExecutionContext {
  return {
    config,
    namespace,
    ...options,
    source: options.runOptions.scope?.source ?? migrationInputSource(config),
    rootBinding: governanceBinding(config.governanceRoot),
  };
}
