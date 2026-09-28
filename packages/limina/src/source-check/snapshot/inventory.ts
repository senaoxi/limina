import { filterInventoryIssues } from './inventory/filters';
import { formatCompletedHumanInventory } from './inventory/human';
import {
  formatJsonInventory,
  formatNdjsonInventory,
} from './inventory/machine';
import type {
  CheckIssueInventoryFilters,
  CheckIssueInventoryMachineOptions,
  CheckIssueInventoryOptions,
  CheckIssueSnapshot,
  LiminaCheckIssue,
} from './types';

function isMachineOptions(
  options: CheckIssueInventoryOptions,
): options is CheckIssueInventoryMachineOptions {
  return options.format === 'json' || options.format === 'ndjson';
}

function getFilters(
  options: CheckIssueInventoryOptions,
): CheckIssueInventoryFilters {
  if (isMachineOptions(options)) return options.filters ?? {};
  return options.queryContext.filters;
}

function formatMissingSnapshot(options: CheckIssueInventoryOptions): string {
  if (options.format === 'json') {
    return formatJsonInventory({
      filteredIssues: [],
      filters: getFilters(options),
      invocation: options.invocation,
      snapshot: null,
    });
  }
  if (options.format === 'ndjson') return '';
  return [
    'No check issue snapshot found.',
    'Run `limina check` first, then run `limina check --issues`.',
  ].join('\n');
}

function formatIncompleteSnapshot(options: {
  inventory: CheckIssueInventoryOptions;
  snapshot: CheckIssueSnapshot;
}): string {
  if (options.inventory.format === 'json') {
    return formatJsonInventory({
      filteredIssues: [],
      filters: getFilters(options.inventory),
      invocation: options.inventory.invocation,
      snapshot: options.snapshot,
    });
  }
  if (options.inventory.format === 'ndjson') return '';
  return [
    'No completed check issue snapshot is available from the last run.',
    'Run `limina check` and let it reach a failing or completed task first.',
  ].join('\n');
}

function formatMachineInventory(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  inventory: CheckIssueInventoryMachineOptions;
  snapshot: CheckIssueSnapshot;
}): string {
  if (options.inventory.format === 'ndjson') {
    return formatNdjsonInventory(options.filteredIssues);
  }
  return formatJsonInventory({
    filteredIssues: options.filteredIssues,
    filters: options.inventory.filters ?? {},
    invocation: options.inventory.invocation,
    snapshot: options.snapshot,
  });
}

function formatCompletedInventory(options: {
  inventory: CheckIssueInventoryOptions;
  snapshot: CheckIssueSnapshot;
}): string {
  const filters = getFilters(options.inventory);
  const filteredIssues = filterInventoryIssues({
    filters,
    issues: options.snapshot.issues,
    rootDir: options.inventory.rootDir,
  });
  if (isMachineOptions(options.inventory)) {
    return formatMachineInventory({
      filteredIssues,
      inventory: options.inventory,
      snapshot: options.snapshot,
    });
  }
  return formatCompletedHumanInventory({
    filteredIssues,
    inventory: options.inventory,
  });
}

export function formatCheckIssueSnapshotInventory(
  options: CheckIssueInventoryOptions,
): string {
  const snapshot = options.snapshot;
  if (snapshot === null) return formatMissingSnapshot(options);
  if (snapshot.status !== 'completed') {
    return formatIncompleteSnapshot({ inventory: options, snapshot });
  }
  return formatCompletedInventory({ inventory: options, snapshot });
}
