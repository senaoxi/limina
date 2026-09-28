import { shouldUseColor } from '#utils/reporting';
import type { InventoryQueryContext } from '../check-reporting/inventory-presentation';
import {
  type CheckIssueInventoryFilters,
  type CheckIssueInventoryInvocationMetadata,
  type CheckIssueSnapshot,
  formatCheckIssueSnapshotInventory,
  locateCheckIssueWorkspace,
  readStandaloneIssueInvocation,
  type StandaloneIssueInvocationSnapshot,
  toCheckIssueInventoryInvocationMetadata,
  toCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import {
  type CheckAttemptQueryResult,
  queryLatestCheckAttempt,
} from '../source-check/snapshot/check-attempt-query';
import {
  assertHumanIssueInventoryLimit,
  assertKnownCheckRuleCodes,
  parseIssueInventoryFormat,
  parseIssueInventoryLimit,
  resolveIssueInventoryPresentation,
} from './issue-inventory';
import { parsePackageNames, parseRepeatedStrings } from './parse';
import type { CheckFlags } from './types';

interface InventoryInput {
  attemptQuery?: CheckAttemptQueryResult;
  invocation?: StandaloneIssueInvocationSnapshot;
  snapshot: CheckIssueSnapshot | null;
}

function createInventoryFilters(flags: CheckFlags): CheckIssueInventoryFilters {
  const rules = parseRepeatedStrings(flags.rule);
  assertKnownCheckRuleCodes(rules);
  return {
    checkerNames: parseRepeatedStrings(flags.checker),
    files: parseRepeatedStrings(flags.file),
    packageNames: parsePackageNames(flags.package),
    rules,
    scopes: parseRepeatedStrings(flags.scope),
    tasks: parseRepeatedStrings(flags.task),
  };
}

function getConfigLoaderField(flags: CheckFlags): { configLoader?: string } {
  if (flags.configLoader === undefined) return {};
  return { configLoader: flags.configLoader };
}

function getConfigPathField(configPath: string | undefined): {
  configPath?: string;
} {
  if (configPath === undefined) return {};
  return { configPath };
}

function getModeField(flags: CheckFlags): { mode?: string } {
  if (flags.mode === undefined) return {};
  return { mode: flags.mode };
}

function createGlobalQueryContext(options: {
  configPath: string | undefined;
  flags: CheckFlags;
}): InventoryQueryContext['global'] {
  return {
    ...getConfigLoaderField(options.flags),
    ...getConfigPathField(options.configPath),
    ...getModeField(options.flags),
  };
}

function getInvocationIdField(invocationId: string | undefined): {
  invocationId?: string;
} {
  if (invocationId === undefined) return {};
  return { invocationId };
}

function createQueryContext(options: {
  configPath: string | undefined;
  filters: CheckIssueInventoryFilters;
  flags: CheckFlags;
  limit: number | null;
  limitExplicit: boolean;
}): InventoryQueryContext {
  return {
    effectiveFormat: 'human',
    filters: options.filters,
    global: createGlobalQueryContext(options),
    ...getInvocationIdField(options.flags.invocation),
    limit: options.limit,
    limitExplicit: options.limitExplicit,
    verbose: options.flags.verbose === true,
  };
}

async function readInventoryInput(options: {
  invocationId: string | undefined;
  rootDir: string;
}): Promise<InventoryInput> {
  if (options.invocationId === undefined) {
    const attemptQuery = await queryLatestCheckAttempt(options.rootDir);
    return { attemptQuery, snapshot: attemptQuery.snapshot };
  }
  const invocation = await readStandaloneIssueInvocation(
    options.rootDir,
    options.invocationId,
  );
  return {
    invocation,
    snapshot: toCheckIssueSnapshot(invocation),
  };
}

function isUnavailableAttemptQuery(
  query: CheckAttemptQueryResult | undefined,
): query is Extract<CheckAttemptQueryResult, { snapshot: null }> {
  if (query === undefined) return false;
  return query.state !== 'completed' && query.state !== 'legacy';
}

function formatUnavailableInventory(options: {
  format: 'human' | 'json' | 'ndjson';
  query: Extract<CheckAttemptQueryResult, { snapshot: null }>;
}): string {
  if (options.format === 'human') {
    return `Issue inventory unavailable: ${options.query.message}`;
  }
  const status = {
    issueCount: 0,
    issues: [],
    message: options.query.message,
    status: options.query.state,
    version: 1,
  };
  if (options.format === 'json') return JSON.stringify(status, null, 2);
  return JSON.stringify({ ...status, type: 'inventory-status' });
}

function getInvocationMetadata(
  invocation: StandaloneIssueInvocationSnapshot | undefined,
): CheckIssueInventoryInvocationMetadata | undefined {
  if (invocation === undefined) return undefined;
  return toCheckIssueInventoryInvocationMetadata(invocation);
}

function getInvocationMetadataField(
  invocation: StandaloneIssueInvocationSnapshot | undefined,
): { invocation?: CheckIssueInventoryInvocationMetadata } {
  const metadata = getInvocationMetadata(invocation);
  if (metadata === undefined) return {};
  return { invocation: metadata };
}

function formatHumanInventory(options: {
  filters: CheckIssueInventoryFilters;
  flags: CheckFlags;
  input: InventoryInput;
  limit: number | null;
  limitExplicit: boolean;
  queryContext: InventoryQueryContext;
  rootDir: string;
}): string {
  return formatCheckIssueSnapshotInventory({
    color: shouldUseColor(),
    format: 'human',
    ...getInvocationMetadataField(options.input.invocation),
    presentation: resolveIssueInventoryPresentation({
      filters: options.filters,
      hasInvocation: options.input.invocation !== undefined,
      limit: options.limit,
      limitExplicit: options.limitExplicit,
      verbose: options.flags.verbose === true,
    }),
    queryContext: options.queryContext,
    rootDir: options.rootDir,
    snapshot: options.input.snapshot,
  });
}

function formatMachineInventory(options: {
  filters: CheckIssueInventoryFilters;
  format: 'json' | 'ndjson';
  input: InventoryInput;
  rootDir: string;
}): string {
  return formatCheckIssueSnapshotInventory({
    filters: options.filters,
    format: options.format,
    ...getInvocationMetadataField(options.input.invocation),
    rootDir: options.rootDir,
    snapshot: options.input.snapshot,
  });
}

function formatInventory(options: {
  filters: CheckIssueInventoryFilters;
  flags: CheckFlags;
  format: 'human' | 'json' | 'ndjson';
  input: InventoryInput;
  limit: number | null;
  limitExplicit: boolean;
  queryContext: InventoryQueryContext;
  rootDir: string;
}): string {
  if (options.format !== 'human') {
    return formatMachineInventory({
      filters: options.filters,
      format: options.format,
      input: options.input,
      rootDir: options.rootDir,
    });
  }
  return formatHumanInventory(options);
}

export async function showIssueInventory(flags: CheckFlags): Promise<void> {
  const format = parseIssueInventoryFormat(flags.format) ?? 'human';
  const limitExplicit = flags.limit !== undefined;
  const limit = parseIssueInventoryLimit(flags.limit);
  assertHumanIssueInventoryLimit({ format, limitExplicit });
  const filters = createInventoryFilters(flags);
  const location = locateCheckIssueWorkspace({ configPath: flags.config });
  const input = await readInventoryInput({
    invocationId: flags.invocation,
    rootDir: location.rootDir,
  });
  const queryContext = createQueryContext({
    configPath: location.configPath,
    filters,
    flags,
    limit,
    limitExplicit,
  });
  if (isUnavailableAttemptQuery(input.attemptQuery)) {
    process.exitCode = 1;
    process.stdout.write(
      `${formatUnavailableInventory({
        format,
        query: input.attemptQuery,
      })}\n`,
    );
    return;
  }
  const output = formatInventory({
    filters,
    flags,
    format,
    input,
    limit,
    limitExplicit,
    queryContext,
    rootDir: location.rootDir,
  });
  process.stdout.write(`${output}\n`);
}
