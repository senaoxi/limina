import {
  formatErrorMessage,
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  TerminalReplacementValidationError,
} from 'limina/internal/migration';
import type { MigrationRecord } from './declarations';
import { isExpectedInputFailure } from './discovery';
import type { FrozenMigrationPlan } from './planner';
import {
  executePreparedMigrationPlan,
  MigrationTransactionError,
  type MigrationTransactionExecutionResult,
  type PreparedMigrationPlan,
  prepareMigrationWritePlan,
} from './transaction';

export interface MigrationExecutionState {
  records: MigrationRecord[];
  incompleteFiles: string[];
  execution: MigrationTransactionExecutionResult;
}

export function createExecutionState(
  plan: FrozenMigrationPlan,
): MigrationExecutionState {
  return {
    records: plan.records,
    incompleteFiles: [],
    execution: {
      cleanupWarnings: [],
      hardlinkRewrittenFiles: [],
      hardlinkSkippedFiles: [],
      modifiedFiles: [],
      skippedFiles: [],
    },
  };
}

async function prepareGroup(options: {
  group: FrozenMigrationPlan['groups'][number];
  roots: string[];
  state: MigrationExecutionState;
}): Promise<PreparedMigrationPlan | undefined> {
  try {
    return await prepareMigrationWritePlan(options.roots, options.group);
  } catch (error) {
    if (!isRecoverablePreflight(error)) throw error;
    const paths = options.group.map((item) => item.configPath);
    options.state.incompleteFiles.push(...paths);
    options.state.records.push({
      configPath: paths[0]!,
      kind: 'write-preflight-failed',
      message: formatErrorMessage(error),
      details: paths,
    });
    return undefined;
  }
}

export async function prepareGroups(options: {
  plan: FrozenMigrationPlan;
  roots: string[];
  state: MigrationExecutionState;
}): Promise<PreparedMigrationPlan[]> {
  const prepared: PreparedMigrationPlan[] = [];
  for (const group of options.plan.groups) {
    const result = await prepareGroup({
      group,
      roots: options.roots,
      state: options.state,
    });
    if (result) prepared.push(result);
  }
  return prepared;
}

function groupPaths(group: PreparedMigrationPlan): string[] {
  return [...group.atomicSnapshots, ...group.hardlinkSnapshots].map(
    (snapshot) => snapshot.item.configPath,
  );
}

function skipGroup(
  group: PreparedMigrationPlan,
  state: MigrationExecutionState,
): void {
  const paths = groupPaths(group);
  state.incompleteFiles.push(...paths);
  state.execution.hardlinkSkippedFiles.push(
    ...group.hardlinkSnapshots.map((snapshot) => snapshot.item.configPath),
  );
  state.execution.skippedFiles.push(...paths, ...group.skippedFiles);
  state.records.push({
    configPath: paths[0]!,
    kind: 'write-group-skipped',
    message: 'Hardlink policy skipped the entire consistency group.',
    details: paths,
  });
}

function recordCompleted(
  completed: MigrationTransactionExecutionResult,
  state: MigrationExecutionState,
): void {
  state.execution.cleanupWarnings.push(...completed.cleanupWarnings);
  state.execution.hardlinkRewrittenFiles.push(
    ...completed.hardlinkRewrittenFiles,
  );
  state.execution.hardlinkSkippedFiles.push(...completed.hardlinkSkippedFiles);
  state.execution.modifiedFiles.push(...completed.modifiedFiles);
  state.execution.skippedFiles.push(...completed.skippedFiles);
  for (const file of completed.modifiedFiles)
    state.records.push({
      configPath: file,
      kind: 'written',
      message: 'Committed and verified.',
    });
}

function recordRestored(
  error: unknown,
  group: PreparedMigrationPlan,
  state: MigrationExecutionState,
): void {
  if (!(error instanceof MigrationTransactionError)) throw error;
  if (error.rollbackFailures.length > 0) throw error;
  const paths = groupPaths(group);
  state.incompleteFiles.push(...paths);
  state.records.push({
    configPath: paths[0]!,
    kind: 'write-group-restored',
    message: error.message,
    details: paths,
  });
}

async function executeGroup(options: {
  group: PreparedMigrationPlan;
  hardlinkPolicy: 'skip' | 'rewrite';
  state: MigrationExecutionState;
}): Promise<void> {
  try {
    recordCompleted(
      await executePreparedMigrationPlan(options.group, {
        hardlinkPolicy: options.hardlinkPolicy,
      }),
      options.state,
    );
  } catch (error) {
    recordRestored(error, options.group, options.state);
  }
}

function shouldSkip(group: PreparedMigrationPlan, policy: string): boolean {
  return policy === 'skip' && group.hardlinkSnapshots.length > 0;
}

export async function executeGroups(options: {
  prepared: PreparedMigrationPlan[];
  hardlinkPolicy: 'skip' | 'rewrite';
  state: MigrationExecutionState;
}): Promise<void> {
  for (const group of options.prepared) {
    if (shouldSkip(group, options.hardlinkPolicy))
      skipGroup(group, options.state);
    else await executeGroup({ ...options, group });
  }
}

function isRecoverablePreflight(error: unknown): boolean {
  return (
    [
      ReplacementDriftError,
      RetryableReplacementValidationIoError,
      TerminalReplacementValidationError,
    ].some((Type) => error instanceof Type) || isExpectedInputFailure(error)
  );
}
