import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import type { PackageOwnerIdentity } from '../../core/workspace/owner-identity';
import {
  isInvalidConfigRootPattern,
  normalizeWorkspacePattern,
  toOwnerRelativeEntryPattern,
} from '../workspace-patterns';
import type {
  ParsedEntryRecord,
  UnusedModuleConfigContext,
  WorkspaceUnusedConfigOptions,
} from './unused/config-types';
import { addKnipEntryFinding as addEntryFinding } from './unused/finding';

function parseEntryFiles(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  value: unknown;
}): unknown[] | null {
  if (Array.isArray(options.value) && options.value.length > 0) {
    return options.value;
  }
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.files`,
    ownerIdentity: options.ownerIdentity,
    reason:
      'files must be a non-empty array of config-root-relative glob patterns.',
    value: options.value,
  });
  return null;
}

function parseEntryReason(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.reason`,
    ownerIdentity: options.ownerIdentity,
    reason: 'reason must be a non-empty string.',
    value: options.value,
  });
  return null;
}

function createParsedEntryRecord(options: {
  files: unknown[] | null;
  reason: string | null;
}): ParsedEntryRecord | null {
  if (options.files === null) return null;
  if (options.reason === null) return null;
  return { files: options.files, reason: options.reason };
}

function parseEntryRecord(options: {
  context: UnusedModuleConfigContext;
  entry: unknown;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
}): ParsedEntryRecord | null {
  if (!isPlainRecord(options.entry)) {
    addEntryFinding({
      ...options,
      details: [`  value: ${formatUnknownValue(options.entry)}`],
      reason:
        'entry configs must be objects with non-empty files and reason fields.',
      value: options.entry,
    });
    return null;
  }
  return createParsedEntryRecord({
    files: parseEntryFiles({
      context: options.context,
      field: options.field,
      ownerIdentity: options.ownerIdentity,
      value: options.entry.files,
    }),
    reason: parseEntryReason({
      context: options.context,
      field: options.field,
      ownerIdentity: options.ownerIdentity,
      value: options.entry.reason,
    }),
  });
}

function isNonEmptyPatternValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.trim().length > 0;
}

function rejectInvalidPattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  pattern: string;
}): string | null {
  if (!isInvalidConfigRootPattern(options.pattern)) return options.pattern;
  addEntryFinding({
    context: options.context,
    details: [`  file: ${options.pattern}`],
    field: options.field,
    ownerIdentity: options.ownerIdentity,
    reason: 'file patterns must be positive config-root-relative globs.',
  });
  return null;
}

function normalizeEntryPattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  value: unknown;
}): string | null {
  if (!isNonEmptyPatternValue(options.value)) {
    addEntryFinding({
      context: options.context,
      details: [`  value: ${formatUnknownValue(options.value)}`],
      field: options.field,
      ownerIdentity: options.ownerIdentity,
      reason: 'file patterns must be non-empty strings.',
      value: options.value,
    });
    return null;
  }
  return rejectInvalidPattern({
    context: options.context,
    field: options.field,
    ownerIdentity: options.ownerIdentity,
    pattern: normalizeWorkspacePattern(options.value),
  });
}

function toOwnerPattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  pattern: string;
}): string | null {
  const moduleSet = options.context.moduleSetByOwnerIdentity.get(
    options.ownerIdentity,
  )!;
  const ownerRelativePattern = toOwnerRelativeEntryPattern({
    config: options.context.config,
    owner: moduleSet.owner,
    pattern: options.pattern,
  });
  if (ownerRelativePattern !== null) return ownerRelativePattern;
  addEntryFinding({
    context: options.context,
    details: [
      `  package: ${moduleSet.owner.packageJsonPath}`,
      `  file: ${options.pattern}`,
    ],
    field: options.field,
    ownerIdentity: options.ownerIdentity,
    reason: 'file patterns must stay inside the keyed package directory.',
  });
  return null;
}

function collectFilePattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
  value: unknown;
}): string[] {
  const pattern = normalizeEntryPattern(options);
  if (pattern === null) return [];
  const ownerPattern = toOwnerPattern({ ...options, pattern });
  return ownerPattern === null ? [] : [ownerPattern];
}

function collectEntryPatterns(options: {
  context: UnusedModuleConfigContext;
  entry: unknown;
  field: string;
  ownerIdentity: PackageOwnerIdentity;
}): string[] {
  const parsed = parseEntryRecord(options);
  if (parsed === null) return [];
  return parsed.files.flatMap((value, index) =>
    collectFilePattern({
      context: options.context,
      field: `${options.field}.files[${index}]`,
      ownerIdentity: options.ownerIdentity,
      value,
    }),
  );
}

function addMissingOwnerFinding(options: WorkspaceUnusedConfigOptions): void {
  const workspaceField = options.workspaceConfig.field;
  addEntryFinding({
    context: options.context,
    details: [`  package: ${options.workspaceConfig.owner.directory}`],
    field: `${workspaceField}.entry`,
    ownerIdentity: options.ownerIdentity,
    reason: 'package must own Limina-governed source modules.',
  });
}

function storeEntryPatterns(options: {
  context: UnusedModuleConfigContext;
  ownerIdentity: PackageOwnerIdentity;
  patterns: string[];
}): void {
  if (options.patterns.length === 0) return;
  options.context.entryPatternsByOwnerIdentity.set(
    options.ownerIdentity,
    uniqueSortedStrings(options.patterns),
  );
}

function collectConfiguredEntries(options: {
  context: UnusedModuleConfigContext;
  ownerIdentity: PackageOwnerIdentity;
  rawEntries: unknown[];
  workspaceField: string;
}): string[] {
  return options.rawEntries.flatMap((entry, index) =>
    collectEntryPatterns({
      context: options.context,
      entry,
      field: `${options.workspaceField}.entry[${index}]`,
      ownerIdentity: options.ownerIdentity,
    }),
  );
}

function getConfiguredEntries(
  options: WorkspaceUnusedConfigOptions,
): unknown[] | null {
  const rawEntries = options.workspaceConfig.entry;
  if (rawEntries === undefined) return null;
  if (Array.isArray(rawEntries)) return rawEntries;
  const workspaceField = options.workspaceConfig.field;
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(rawEntries)}`],
    field: `${workspaceField}.entry`,
    ownerIdentity: options.ownerIdentity,
    reason: 'entry must be an array.',
    value: rawEntries,
  });
  return null;
}

export function collectWorkspaceEntryConfig(
  options: WorkspaceUnusedConfigOptions,
): void {
  const rawEntries = getConfiguredEntries(options);
  if (rawEntries === null) return;
  if (!options.context.moduleSetByOwnerIdentity.has(options.ownerIdentity)) {
    addMissingOwnerFinding(options);
    return;
  }
  const workspaceField = options.workspaceConfig.field;
  storeEntryPatterns({
    context: options.context,
    ownerIdentity: options.ownerIdentity,
    patterns: collectConfiguredEntries({
      context: options.context,
      ownerIdentity: options.ownerIdentity,
      rawEntries,
      workspaceField,
    }),
  });
}
