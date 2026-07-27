import { uniqueValues } from '#utils/collections';
import {
  type CheckIssueInventoryPresentationOptions,
  DEFAULT_VISIBLE_ISSUE_LIMIT,
  formatInventoryQueryCommand,
  type HumanPrimaryBlocker,
  type InventoryQueryContext,
} from '../inventory-presentation';
import type {
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from '../snapshot';

export interface FailedTaskSelection {
  label: string;
  queryTask?: string;
}

export interface NextCommandEntry {
  command: string;
  label: string;
}

function withQueryTask(
  label: string,
  queryTask: string | undefined,
): FailedTaskSelection {
  return queryTask === undefined ? { label } : { label, queryTask };
}

function matchesBlockedTask(options: {
  blockedId: string | undefined;
  blockedLabel: string;
  task: LiminaCheckRunTaskSummary;
}): boolean {
  if (options.task.label === options.blockedLabel) return true;
  return options.task.id === options.blockedId;
}

interface BlockedTaskContext {
  id: string | undefined;
  label: string;
  run: LiminaCheckRunSummary;
}

function getBlockedTaskContext(
  run: LiminaCheckRunSummary | undefined,
): BlockedTaskContext | null {
  if (run === undefined) return null;
  if (run.blockedBy === undefined) return null;
  return { id: run.blockedBy.id, label: run.blockedBy.label, run };
}

function getIssueTask(
  task: LiminaCheckRunTaskSummary | undefined,
): string | undefined {
  return task === undefined ? undefined : task.issueTask;
}

function getBlockedTaskSelection(
  run: LiminaCheckRunSummary | undefined,
): FailedTaskSelection | null {
  const blocked = getBlockedTaskContext(run);
  if (blocked === null) return null;
  const blockedTask = blocked.run.tasks.find((task) =>
    matchesBlockedTask({
      blockedId: blocked.id,
      blockedLabel: blocked.label,
      task,
    }),
  );
  return withQueryTask(blocked.label, getIssueTask(blockedTask));
}

function getFailedTasks(
  run: LiminaCheckRunSummary | undefined,
): LiminaCheckRunTaskSummary[] {
  if (run === undefined) return [];
  return run.tasks.filter((task) => task.state === 'failed');
}

function getUniqueFailedTaskSelection(
  run: LiminaCheckRunSummary | undefined,
): FailedTaskSelection | null {
  const failedTasks = getFailedTasks(run);
  const labels = uniqueValues(failedTasks.map((task) => task.label));
  if (labels.length !== 1) return null;
  const issueTasks = uniqueValues(failedTasks.map((task) => task.issueTask));
  const queryTask = issueTasks.length === 1 ? issueTasks[0] : undefined;
  return withQueryTask(labels[0]!, queryTask);
}

export function getFailedTask(
  run: LiminaCheckRunSummary | undefined,
): FailedTaskSelection | null {
  return getBlockedTaskSelection(run) ?? getUniqueFailedTaskSelection(run);
}

export function formatNextCommandEntries(
  entries: readonly NextCommandEntry[],
): string[] {
  const labelWidth = Math.max(
    ...entries.map((entry) => `${entry.label}:`.length),
  );
  return entries.map(
    (entry) => `${`${entry.label}:`.padEnd(labelWidth)} ${entry.command}`,
  );
}

export function createDefaultInventoryQueryContext(): InventoryQueryContext {
  return {
    effectiveFormat: 'human',
    filters: {},
    global: {},
    limit: DEFAULT_VISIBLE_ISSUE_LIMIT,
    limitExplicit: false,
    verbose: false,
  };
}

function getFailedTaskFilters(
  failedTask: FailedTaskSelection | null,
): string[] | undefined {
  if (failedTask?.queryTask === undefined) return undefined;
  return [failedTask.queryTask];
}

function createRuleCommand(options: {
  queryContext: InventoryQueryContext;
  topBlocker: HumanPrimaryBlocker | undefined;
}): NextCommandEntry[] {
  if (options.topBlocker === undefined) return [];
  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        additionalFilters: { rules: [options.topBlocker.code] },
        limit: 'preserve',
        verbose: true,
      }),
      label: 'By rule',
    },
  ];
}

export function createCheckRunNextCommands(options: {
  failedTask: FailedTaskSelection | null;
  queryContext: InventoryQueryContext;
  topBlocker: HumanPrimaryBlocker | undefined;
}): NextCommandEntry[] {
  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        additionalFilters: { tasks: getFailedTaskFilters(options.failedTask) },
        limit: 'preserve',
        verbose: true,
      }),
      label: 'Verbose',
    },
    ...createRuleCommand(options),
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        format: 'json',
      }),
      label: 'JSON',
    },
  ];
}

function createShowIssuesCommand(options: {
  presentation: CheckIssueInventoryPresentationOptions;
  queryContext: InventoryQueryContext;
}): NextCommandEntry[] {
  if (options.presentation.view !== 'summary') return [];
  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: options.presentation.maxIssues ?? 'all',
      }),
      label: 'Show issues',
    },
  ];
}

function createRefineCommand(options: {
  primaryBlocker: HumanPrimaryBlocker | undefined;
  queryContext: InventoryQueryContext;
}): NextCommandEntry[] {
  if (options.primaryBlocker === undefined) return [];
  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        additionalFilters: {
          rules: [options.primaryBlocker.code],
          tasks: [options.primaryBlocker.task],
        },
        limit: 'preserve',
        verbose: options.queryContext.verbose,
      }),
      label: 'Refine',
    },
  ];
}

function createDetailedCommand(options: {
  presentation: CheckIssueInventoryPresentationOptions;
  queryContext: InventoryQueryContext;
}): NextCommandEntry[] {
  if (options.presentation.view === 'detailed') return [];
  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: 'preserve',
        verbose: true,
      }),
      label: 'Detailed',
    },
  ];
}

export function createIssueSnapshotNextCommands(options: {
  presentation: CheckIssueInventoryPresentationOptions;
  primaryBlocker: HumanPrimaryBlocker | undefined;
  queryContext: InventoryQueryContext;
}): NextCommandEntry[] {
  return [
    ...createShowIssuesCommand(options),
    ...createRefineCommand(options),
    ...createDetailedCommand(options),
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: 'all',
        verbose: options.queryContext.verbose,
      }),
      label: 'Complete',
    },
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        format: 'json',
      }),
      label: 'JSON',
    },
  ];
}
