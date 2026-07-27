import { formatShellCommand } from '../shell-command';
import type { CheckIssueInventoryFilters } from '../snapshot';
import type {
  FormatInventoryQueryCommandOptions,
  InventoryQueryContext,
} from './types';

function uniqueInOrder(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function mergeFilterValues(
  current: readonly string[] | undefined,
  additional: readonly string[] | undefined,
): string[] {
  return uniqueInOrder([...(current ?? []), ...(additional ?? [])]);
}

function getAdditionalValues(
  additional: CheckIssueInventoryFilters | undefined,
  key: keyof CheckIssueInventoryFilters,
): readonly string[] | undefined {
  if (additional === undefined) return undefined;
  return additional[key];
}

function mergeInventoryFilters(
  current: CheckIssueInventoryFilters,
  additional: CheckIssueInventoryFilters | undefined,
): CheckIssueInventoryFilters {
  return {
    checkerNames: mergeFilterValues(
      current.checkerNames,
      getAdditionalValues(additional, 'checkerNames'),
    ),
    files: mergeFilterValues(
      current.files,
      getAdditionalValues(additional, 'files'),
    ),
    packageNames: mergeFilterValues(
      current.packageNames,
      getAdditionalValues(additional, 'packageNames'),
    ),
    rules: mergeFilterValues(
      current.rules,
      getAdditionalValues(additional, 'rules'),
    ),
    scopes: mergeFilterValues(
      current.scopes,
      getAdditionalValues(additional, 'scopes'),
    ),
    tasks: mergeFilterValues(
      current.tasks,
      getAdditionalValues(additional, 'tasks'),
    ),
  };
}

function appendRepeatedFilterTokens(
  tokens: string[],
  option: string,
  values: readonly string[] | undefined,
): void {
  for (const value of values ?? []) {
    tokens.push(option, value);
  }
}

function appendInventoryFilterTokens(
  tokens: string[],
  filters: CheckIssueInventoryFilters,
): void {
  appendRepeatedFilterTokens(tokens, '--task', filters.tasks);
  appendRepeatedFilterTokens(tokens, '--rule', filters.rules);
  appendRepeatedFilterTokens(tokens, '--package', filters.packageNames);
  appendRepeatedFilterTokens(tokens, '--file', filters.files);
  appendRepeatedFilterTokens(tokens, '--scope', filters.scopes);
  appendRepeatedFilterTokens(tokens, '--checker', filters.checkerNames);
}

function appendVerboseToken(
  tokens: string[],
  options: FormatInventoryQueryCommandOptions,
): void {
  if (options.verbose === true) tokens.push('--verbose');
}

function appendNumericLimit(tokens: string[], limit: number): void {
  tokens.push('--limit', String(limit));
}

function appendPreservedLimit(
  tokens: string[],
  context: InventoryQueryContext,
): void {
  if (!context.limitExplicit) return;
  const value = context.limit === null ? 'all' : String(context.limit);
  tokens.push('--limit', value);
}

type NamedLimit = Exclude<
  NonNullable<FormatInventoryQueryCommandOptions['limit']>,
  number | 'omit'
>;

type NamedLimitAppender = (
  tokens: string[],
  context: InventoryQueryContext,
) => void;

const namedLimitAppenders: Readonly<Record<NamedLimit, NamedLimitAppender>> = {
  all(tokens): void {
    tokens.push('--limit', 'all');
  },
  preserve: appendPreservedLimit,
};

function getCommandLimit(
  options: FormatInventoryQueryCommandOptions,
): NonNullable<FormatInventoryQueryCommandOptions['limit']> {
  return options.limit ?? 'omit';
}

function appendLimitTokens(
  tokens: string[],
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions,
): void {
  const limit = getCommandLimit(options);
  if (typeof limit === 'number') {
    appendNumericLimit(tokens, limit);
    return;
  }
  if (limit === 'omit') return;
  namedLimitAppenders[limit](tokens, context);
}

function appendHumanViewTokens(
  tokens: string[],
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions,
): void {
  if (options.filterHelp !== undefined) {
    tokens.push(`--${options.filterHelp}`, '--help');
    return;
  }
  appendVerboseToken(tokens, options);
  appendLimitTokens(tokens, context, options);
}

function appendOptionalToken(
  tokens: string[],
  option: string,
  value: string | undefined,
): void {
  if (value !== undefined) tokens.push(option, value);
}

function appendGlobalTokens(
  tokens: string[],
  context: InventoryQueryContext,
): void {
  appendOptionalToken(tokens, '--config', context.global.configPath);
  appendOptionalToken(tokens, '--config-loader', context.global.configLoader);
  appendOptionalToken(tokens, '--mode', context.global.mode);
}

function appendInvocationToken(
  tokens: string[],
  context: InventoryQueryContext,
): void {
  appendOptionalToken(tokens, '--invocation', context.invocationId);
}

function appendFormatTokens(
  tokens: string[],
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions,
): void {
  if (options.format === 'json') {
    tokens.push('--format', 'json');
    return;
  }
  appendHumanViewTokens(tokens, context, options);
}

export function formatInventoryQueryCommand(
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions = {},
): string {
  const tokens = ['limina'];
  appendGlobalTokens(tokens, context);
  tokens.push('check', '--issues');
  appendInvocationToken(tokens, context);
  appendInventoryFilterTokens(
    tokens,
    mergeInventoryFilters(context.filters, options.additionalFilters),
  );
  appendFormatTokens(tokens, context, options);
  return formatShellCommand(tokens, options.dialect);
}
