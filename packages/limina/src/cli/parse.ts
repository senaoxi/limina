import type {
  BuildCheckerPreset,
  LiminaConfigLoader,
  PackageAttwProfile,
  PackageCheckToolSelection,
} from '#config/runner';
import type { DependencyGraphView } from '../dependency-graph/runner';
import type { SourceIssueReportOptions } from '../source-check/report';
import type { SourceIssueSelectionFlags } from './types';

export {
  assertHumanIssueInventoryLimit,
  assertKnownCheckRuleCodes,
  assertStandaloneIssuesFlag,
  parseIssueInventoryFormat,
  parseIssueInventoryLimit,
  resolveIssueInventoryPresentation,
} from './issue-inventory';
export {
  getBuildWatchFlag,
  getCheckerWatchFlag,
  rejectUnknownBuildOptions,
  rejectUnknownCheckerOptions,
} from './option-validation';

const CONFIG_LOADERS = new Set<string>(['native', 'tsx']);
const PACKAGE_TOOLS = new Set<string>(['all', 'publint', 'attw', 'boundary']);
const BUILD_PRESETS = new Set<string>(['tsc', 'vue-tsc', 'tsgo']);
const ATTW_PROFILES = new Set<string>(['strict', 'node16', 'esm-only']);
const GRAPH_VIEWS = new Set<string>(['all', 'artifact', 'source']);

function hasOptionalValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function parseOptionalEnum<T extends string>(options: {
  allowed: ReadonlySet<string>;
  error: (value: string) => Error;
  value: string | undefined;
}): T | undefined {
  if (!hasOptionalValue(options.value)) return undefined;
  if (options.allowed.has(options.value)) return options.value as T;
  throw options.error(options.value);
}

function toRepeatedValues(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function normalizeRepeatedValue(
  value: string | string[] | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const values = toRepeatedValues(value)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length === 0 ? undefined : values;
}

export function parseConfigLoader(
  value: string | undefined,
): LiminaConfigLoader | undefined {
  return parseOptionalEnum<LiminaConfigLoader>({
    allowed: CONFIG_LOADERS,
    error: (loader) =>
      new Error(
        `Unsupported Limina config loader "${loader}". Expected one of: native, tsx.`,
      ),
    value,
  });
}

export function parsePackageTool(
  value: string | undefined,
): PackageCheckToolSelection | undefined {
  return parseOptionalEnum<PackageCheckToolSelection>({
    allowed: PACKAGE_TOOLS,
    error: (tool) =>
      new Error(
        `Invalid package check --tool "${tool}". Expected one of: all, publint, attw, boundary.`,
      ),
    value,
  });
}

export function parseBuildPreset(
  value: string | undefined,
  commandLabel = 'checker build',
): BuildCheckerPreset | undefined {
  return parseOptionalEnum<BuildCheckerPreset>({
    allowed: BUILD_PRESETS,
    error: (preset) =>
      new Error(
        `Invalid ${commandLabel} --preset "${preset}". Expected one of: tsc, vue-tsc, tsgo.`,
      ),
    value,
  });
}

export function parsePackageAttwProfile(
  value: string | undefined,
): PackageAttwProfile | undefined {
  return parseOptionalEnum<PackageAttwProfile>({
    allowed: ATTW_PROFILES,
    error: (profile) =>
      new Error(
        `Invalid package check --attw-profile "${profile}". Expected one of: strict, node16, esm-only.`,
      ),
    value,
  });
}

export function parsePackageNames(
  value: string | string[] | undefined,
): string[] | undefined {
  return normalizeRepeatedValue(value);
}

export function parseRepeatedStrings(
  value: string | string[] | undefined,
): string[] | undefined {
  return normalizeRepeatedValue(value);
}

export function createSourceIssueReportOptions(
  flags: SourceIssueSelectionFlags,
  command: string,
): SourceIssueReportOptions {
  return {
    command,
    files: parseRepeatedStrings(flags.file),
    packageNames: parsePackageNames(flags.package),
    rules: parseRepeatedStrings(flags.rule),
    scopes: parseRepeatedStrings(flags.scope),
    verbose: flags.verbose,
  };
}

export function parseDependencyGraphView(
  value: string | undefined,
): DependencyGraphView | undefined {
  return parseOptionalEnum<DependencyGraphView>({
    allowed: GRAPH_VIEWS,
    error: (view) =>
      new Error(
        `Invalid graph export --view "${view}". Expected one of: all, artifact, source.`,
      ),
    value,
  });
}
