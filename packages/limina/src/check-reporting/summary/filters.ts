import {
  formatInventoryQueryCommand,
  type InventoryQueryContext,
} from '../inventory-presentation';
import type {
  CheckIssueInventoryFilters,
  CheckIssueSnapshot,
} from '../snapshot';
import { type CountEntry, createHumanIssueOverview } from './overview';

interface FilterSelection {
  label: string;
  values: readonly string[] | undefined;
}

function hasSelectedValues(
  values: readonly string[] | undefined,
): values is readonly string[] {
  if (values === undefined) return false;
  return values.length > 0;
}

function getFilterSelections(
  filters: CheckIssueInventoryFilters | undefined,
): readonly FilterSelection[] {
  if (filters === undefined) return [];
  return [
    { label: 'task', values: filters.tasks },
    { label: 'package', values: filters.packageNames },
    { label: 'rule', values: filters.rules },
    { label: 'file', values: filters.files },
    { label: 'scope', values: filters.scopes },
    { label: 'checker', values: filters.checkerNames },
  ];
}

export function hasFilters(
  filters: CheckIssueInventoryFilters | undefined,
): filters is CheckIssueInventoryFilters {
  return getFilterSelections(filters).some((entry) =>
    hasSelectedValues(entry.values),
  );
}

function formatFilterSelection(selection: FilterSelection): string[] {
  const values = selection.values;
  if (!hasSelectedValues(values)) return [];
  return [`  ${selection.label}: ${values.join(', ')}`];
}

export function formatFilters(
  filters: CheckIssueInventoryFilters | undefined,
): string[] {
  if (!hasFilters(filters)) return [];
  return [
    'Filters:',
    ...getFilterSelections(filters).flatMap(formatFilterSelection),
  ];
}

function getEntryNames(entries: readonly CountEntry[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => entry.name));
}

function findUnavailableFilterValues(
  selectedValues: readonly string[] | undefined,
  availableValues: ReadonlySet<string>,
): string[] {
  const selected = selectedValues ?? [];
  return selected.filter((value) => !availableValues.has(value));
}

function formatUnavailableFilterLines(options: {
  availableValues: ReadonlySet<string>;
  filterLabel: 'checker' | 'package' | 'task';
  helpCommand: string;
  selectedValues: readonly string[] | undefined;
}): string[] {
  const unavailable = findUnavailableFilterValues(
    options.selectedValues,
    options.availableValues,
  );
  return unavailable.flatMap((value) => [
    `  - ${options.filterLabel} "${value}" has no issues in the last snapshot.`,
    `    Help: ${options.helpCommand}`,
  ]);
}

function formatUnavailableRuleLines(options: {
  availableValues: ReadonlySet<string>;
  helpCommand: string;
  selectedValues: readonly string[] | undefined;
}): string[] {
  const unavailable = findUnavailableFilterValues(
    options.selectedValues,
    options.availableValues,
  );
  return unavailable.flatMap((value) => [
    `  - Supported rule "${value}" is absent from the last snapshot.`,
    `    Help: ${options.helpCommand}`,
  ]);
}

function createFilterHelpCommand(
  queryContext: InventoryQueryContext,
  filterHelp: 'checker' | 'package' | 'rule' | 'task',
): string {
  return formatInventoryQueryCommand(queryContext, { filterHelp });
}

function createValueDiagnostics(options: {
  filters: CheckIssueInventoryFilters;
  queryContext: InventoryQueryContext;
  snapshot: CheckIssueSnapshot;
}): string[] {
  const overview = createHumanIssueOverview(options.snapshot.issues);
  return [
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.tasks),
      filterLabel: 'task',
      helpCommand: createFilterHelpCommand(options.queryContext, 'task'),
      selectedValues: options.filters.tasks,
    }),
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.packages),
      filterLabel: 'package',
      helpCommand: createFilterHelpCommand(options.queryContext, 'package'),
      selectedValues: options.filters.packageNames,
    }),
    ...formatUnavailableRuleLines({
      availableValues: getEntryNames(overview.rules),
      helpCommand: createFilterHelpCommand(options.queryContext, 'rule'),
      selectedValues: options.filters.rules,
    }),
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.checkers),
      filterLabel: 'checker',
      helpCommand: createFilterHelpCommand(options.queryContext, 'checker'),
      selectedValues: options.filters.checkerNames,
    }),
  ];
}

function addDiagnosticsHeading(diagnostics: readonly string[]): string[] {
  if (diagnostics.length === 0) return [];
  return ['Filter diagnostics:', ...diagnostics];
}

export function formatFilterDiagnostics(options: {
  filters: CheckIssueInventoryFilters | undefined;
  queryContext: InventoryQueryContext;
  snapshot: CheckIssueSnapshot;
}): string[] {
  if (!hasFilters(options.filters)) return [];
  const diagnostics = createValueDiagnostics({
    filters: options.filters,
    queryContext: options.queryContext,
    snapshot: options.snapshot,
  });
  return addDiagnosticsHeading(diagnostics);
}
