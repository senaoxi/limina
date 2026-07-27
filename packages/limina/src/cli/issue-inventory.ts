import { isLiminaCheckIssueCode } from '../check-reporting/codes';
import {
  type CheckIssueInventoryPresentationOptions,
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  DEFAULT_VISIBLE_ISSUE_LIMIT,
} from '../check-reporting/inventory-presentation';
import type {
  CheckIssueInventoryFilters,
  CheckIssueInventoryFormat,
} from '../check-reporting/snapshot';
import type { CheckFlags } from './types';

const INVENTORY_FORMATS = new Set<string>(['human', 'json', 'ndjson']);

function hasInventoryFilterValues(
  filters: CheckIssueInventoryFilters,
): boolean {
  return Object.values(filters).some(
    (values) => values !== undefined && values.length > 0,
  );
}

function getInventorySelectorState(options: {
  filters: CheckIssueInventoryFilters;
  hasInvocation: boolean;
}): boolean {
  if (options.hasInvocation) return true;
  return hasInventoryFilterValues(options.filters);
}

function formatUnknownRuleCodeLabel(count: number): string {
  return count > 1 ? 'codes' : 'code';
}

export function assertKnownCheckRuleCodes(rules: string[] | undefined): void {
  if (rules === undefined) return;
  const unknown = rules.filter((rule) => !isLiminaCheckIssueCode(rule));
  if (unknown.length === 0) return;
  const label = formatUnknownRuleCodeLabel(unknown.length);
  const quoted = unknown.map((rule) => `"${rule}"`).join(', ');
  throw new Error(
    [
      `Unknown check --rule ${label} ${quoted}.`,
      'Run `limina check --issues --rule --help` to see supported rule codes.',
    ].join('\n'),
  );
}

function hasInventoryFormat(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function parseIssueInventoryFormat(
  value: string | undefined,
): CheckIssueInventoryFormat | undefined {
  if (!hasInventoryFormat(value)) return undefined;
  if (INVENTORY_FORMATS.has(value)) return value as CheckIssueInventoryFormat;
  throw new Error(
    `Invalid check --issues --format "${value}". Expected one of: human, json, ndjson.`,
  );
}

function createInventoryLimitError(value: string): Error {
  return new Error(
    `Invalid check --issues --limit "${value}". Expected a positive integer or "all".`,
  );
}

function assertPositiveInventoryLimit(parsed: number, raw: string): void {
  if (!Number.isSafeInteger(parsed)) throw createInventoryLimitError(raw);
  if (parsed <= 0) throw createInventoryLimitError(raw);
}

function parsePositiveInventoryLimit(raw: string): number {
  if (!/^\d+$/u.test(raw)) throw createInventoryLimitError(raw);
  const parsed = Number(raw);
  assertPositiveInventoryLimit(parsed, raw);
  return parsed;
}

export function parseIssueInventoryLimit(
  value: number | string | undefined,
): number | null {
  if (value === undefined) return DEFAULT_VISIBLE_ISSUE_LIMIT;
  const raw = String(value);
  if (raw === 'all') return null;
  return parsePositiveInventoryLimit(raw);
}

export function assertHumanIssueInventoryLimit(options: {
  format: CheckIssueInventoryFormat;
  limitExplicit: boolean;
}): void {
  if (!options.limitExplicit || options.format === 'human') return;
  throw new Error(
    '`limina check --issues --limit` is only available with --format human.',
  );
}

function resolveUndetailedInventoryView(options: {
  limitExplicit: boolean;
  selected: boolean;
}): CheckIssueInventoryPresentationOptions['view'] {
  if (options.selected) return 'compact';
  return options.limitExplicit ? 'compact' : 'summary';
}

function resolveInventoryView(options: {
  limitExplicit: boolean;
  selected: boolean;
  verbose: boolean;
}): CheckIssueInventoryPresentationOptions['view'] {
  if (options.verbose) return 'detailed';
  return resolveUndetailedInventoryView(options);
}

export function resolveIssueInventoryPresentation(options: {
  filters: CheckIssueInventoryFilters;
  hasInvocation: boolean;
  limit: number | null;
  limitExplicit: boolean;
  verbose: boolean;
}): CheckIssueInventoryPresentationOptions {
  const selected = getInventorySelectorState(options);
  const view = resolveInventoryView({
    limitExplicit: options.limitExplicit,
    selected,
    verbose: options.verbose,
  });
  return {
    maxIssues: options.limit,
    maxPrimaryBlockers: DEFAULT_PRIMARY_BLOCKER_LIMIT,
    view,
  };
}

function assertIssuePipelineCompatibility(
  pipeline: string | undefined,
  issues: boolean | undefined,
): void {
  if (issues !== true) return;
  if (pipeline === undefined) return;
  throw new Error('`limina check --issues` does not accept a pipeline name.');
}

function hasIssueOnlyFlags(flags: CheckFlags): boolean {
  return [
    flags.task,
    flags.checker,
    flags.format,
    flags.invocation,
    flags.limit,
  ].some((value) => value !== undefined);
}

export function assertStandaloneIssuesFlag(
  pipeline: string | undefined,
  flags: CheckFlags,
): void {
  assertIssuePipelineCompatibility(pipeline, flags.issues);
  if (flags.issues === true) return;
  if (!hasIssueOnlyFlags(flags)) return;
  throw new Error(
    '`limina check --task`, `--checker`, `--format`, `--invocation`, and `--limit` require --issues.',
  );
}
