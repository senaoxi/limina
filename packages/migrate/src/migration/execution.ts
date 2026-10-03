import { writeJsonAtomically } from 'limina/internal/check-reporting/atomic-writer';
import type { ResolvedLiminaConfig } from 'limina/internal/config/runner';
import type { DependencyAnalysisResult } from 'limina/internal/core/build-graph/types';
import { formatErrorMessage, MigrationLogger } from 'limina/internal/logger';
import type { LiminaPreflightManager } from 'limina/internal/preflight';
import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import path from 'pathe';
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
import { MigrationPlanningError } from './progress';
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

function createResult(options: {
  config: ResolvedLiminaConfig;
  plan: FrozenMigrationPlan;
  state: MigrationExecutionState;
  verification: MigrationDiskVerification;
}): RunMigrationResult {
  const { config, plan, state, verification } = options;
  const analysis = readAnalysis(plan.records);
  if (plan.incomplete) state.incompleteFiles.push(config.configPath);
  return {
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

async function publishReport(options: {
  config: ResolvedLiminaConfig;
  preflight: LiminaPreflightManager;
  plan: FrozenMigrationPlan;
  verification: MigrationDiskVerification;
  result: RunMigrationResult;
  runOptions: RunMigrationOptions;
}): Promise<void> {
  const reportPath = path.join(
    options.config.rootDir,
    '.limina/migration/latest.json',
  );
  try {
    await writeJsonAtomically(options.preflight.artifactNamespace, reportPath, {
      version: 1,
      result: options.result,
      records: options.plan.records,
      verification: options.verification,
    });
    options.result.reportPath = reportPath;
  } catch (error) {
    options.result.reportWarning = `Migration report publication failed: ${formatErrorMessage(error)}`;
    MigrationLogger.warn(options.result.reportWarning);
    options.runOptions.flow?.warn(options.result.reportWarning);
  }
}

export async function runMigrationImpl(
  config: ResolvedLiminaConfig,
  preflight: LiminaPreflightManager,
  options: { runOptions: RunMigrationOptions; task: MigrationTask },
): Promise<RunMigrationImplResult> {
  let plan: FrozenMigrationPlan | undefined;
  try {
    plan = await createFrozenMigrationPlan(config, preflight.artifactNamespace);
    const state = createExecutionState(plan);
    const roots = [
      ...new Set(await collectMigrationWorktreeRoots(plan.groups.flat())),
    ];
    // Freeze all physical snapshots before any mutation. Analysis never resumes after writing.
    const prepared = await prepareGroups({ plan, roots, state });
    assertUniquePhysicalTargets(
      prepared.flatMap((group) => [
        ...group.atomicSnapshots,
        ...group.hardlinkSnapshots,
      ]),
    );
    await confirmDirtyWorkspaceChanges({ roots, ...options });
    const hardlinkPolicy = await decideHardlinkPolicy({
      configRootDir: config.rootDir,
      hardlinkConfigPaths: prepared.flatMap((group) =>
        group.hardlinkSnapshots.map((snapshot) => snapshot.item.configPath),
      ),
      ...options,
    });
    await assertPlanningInputsUnchanged(plan);
    await executeGroups({ prepared, hardlinkPolicy, state });
    const verification = await verifyMigrationFromDisk(
      config,
      plan.topology,
      options.runOptions,
    );
    const result = createResult({ config, plan, state, verification });
    await publishReport({
      config,
      preflight,
      plan,
      verification,
      result,
      runOptions: options.runOptions,
    });
    for (const diagnostic of verification.diagnostics)
      MigrationLogger.warn(diagnostic);
    return { cleanupWarnings: state.execution.cleanupWarnings, result };
  } catch (error) {
    await publishFailure({
      config,
      preflight,
      plan,
      error,
      runOptions: options.runOptions,
    });
    throw error;
  }
}

async function publishFailure(options: {
  config: ResolvedLiminaConfig;
  preflight: LiminaPreflightManager;
  plan?: FrozenMigrationPlan;
  error: unknown;
  runOptions: RunMigrationOptions;
}): Promise<void> {
  const message = stripVTControlCharacters(formatErrorMessage(options.error));
  const records = failureRecords(options);
  const reportPath = path.join(
    options.config.rootDir,
    '.limina/migration/latest.json',
  );
  try {
    await writeJsonAtomically(options.preflight.artifactNamespace, reportPath, {
      version: 1,
      result: {
        processingComplete: false,
        inputConsumable: false,
        incompleteFiles: [options.config.configPath],
      },
      records: [
        ...records,
        {
          configPath: options.config.configPath,
          kind: 'migration-failed',
          message,
        },
      ],
      verification: {
        consumable: false,
        diagnostics: [
          'Migration stopped before disk consumption could be confirmed.',
        ],
        topologies: [],
      },
    });
    MigrationLogger.info(`migration audit: ${reportPath}`);
  } catch (error) {
    const warning = `Migration failure report publication failed: ${formatErrorMessage(error)}`;
    MigrationLogger.warn(warning);
    options.runOptions.flow?.warn(warning);
  }
}

function failureRecords(options: {
  plan?: FrozenMigrationPlan;
  error: unknown;
}): MigrationRecord[] {
  if (options.plan) return options.plan.records;
  return options.error instanceof MigrationPlanningError
    ? options.error.records
    : [];
}
