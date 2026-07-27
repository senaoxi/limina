import { uniqueSortedStrings } from '#utils/collections';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import {
  isInvalidConfigRootPattern,
  normalizeWorkspacePattern,
  toOwnerRelativeEntryPattern,
} from '../workspace-patterns';
import { formatSourceKnipWorkspaceField } from './routing';
import type {
  ParsedEntryRecord,
  UnusedModuleConfigContext,
  WorkspaceUnusedConfigOptions,
} from './unused/config-types';
import { addKnipConfigFinding } from './unused/finding';

function addEntryFinding(options: {
  context: UnusedModuleConfigContext;
  details: readonly string[];
  field: string;
  ownerName: string;
  reason: string;
  value?: unknown;
}): void {
  const moduleSet = options.context.moduleSetByOwnerName.get(options.ownerName);
  addKnipConfigFinding({
    details: options.details,
    field: options.field,
    findings: options.context.findings,
    kind: 'entry',
    packageJsonPath: moduleSet?.owner.packageJsonPath,
    packageName: options.ownerName,
    reason: options.reason,
    title: 'Invalid source Knip entry config',
    value: options.value,
  });
}

function parseEntryFiles(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  value: unknown;
}): unknown[] | null {
  if (Array.isArray(options.value) && options.value.length > 0) {
    return options.value;
  }
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.files`,
    ownerName: options.ownerName,
    reason:
      'files must be a non-empty array of config-root-relative glob patterns.',
    value: options.value,
  });
  return null;
}

function parseEntryReason(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.reason`,
    ownerName: options.ownerName,
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
  ownerName: string;
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
      ownerName: options.ownerName,
      value: options.entry.files,
    }),
    reason: parseEntryReason({
      context: options.context,
      field: options.field,
      ownerName: options.ownerName,
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
  ownerName: string;
  pattern: string;
}): string | null {
  if (!isInvalidConfigRootPattern(options.pattern)) return options.pattern;
  addEntryFinding({
    context: options.context,
    details: [`  file: ${options.pattern}`],
    field: options.field,
    ownerName: options.ownerName,
    reason: 'file patterns must be positive config-root-relative globs.',
  });
  return null;
}

function normalizeEntryPattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  value: unknown;
}): string | null {
  if (!isNonEmptyPatternValue(options.value)) {
    addEntryFinding({
      context: options.context,
      details: [`  value: ${formatUnknownValue(options.value)}`],
      field: options.field,
      ownerName: options.ownerName,
      reason: 'file patterns must be non-empty strings.',
      value: options.value,
    });
    return null;
  }
  return rejectInvalidPattern({
    context: options.context,
    field: options.field,
    ownerName: options.ownerName,
    pattern: normalizeWorkspacePattern(options.value),
  });
}

function toOwnerPattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  pattern: string;
}): string | null {
  const moduleSet = options.context.moduleSetByOwnerName.get(
    options.ownerName,
  )!;
  const ownerRelativePattern = toOwnerRelativeEntryPattern({
    config: options.context.config,
    owner: moduleSet.owner,
    pattern: options.pattern,
  });
  if (ownerRelativePattern !== null) return ownerRelativePattern;
  addEntryFinding({
    context: options.context,
    details: [`  package: ${options.ownerName}`, `  file: ${options.pattern}`],
    field: options.field,
    ownerName: options.ownerName,
    reason: 'file patterns must stay inside the keyed package directory.',
  });
  return null;
}

function collectFilePattern(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
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
  ownerName: string;
}): string[] {
  const parsed = parseEntryRecord(options);
  if (parsed === null) return [];
  return parsed.files.flatMap((value, index) =>
    collectFilePattern({
      context: options.context,
      field: `${options.field}.files[${index}]`,
      ownerName: options.ownerName,
      value,
    }),
  );
}

function addMissingOwnerFinding(options: WorkspaceUnusedConfigOptions): void {
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  addEntryFinding({
    context: options.context,
    details: [`  package: ${options.ownerName}`],
    field: `${workspaceField}.entry`,
    ownerName: options.ownerName,
    reason: 'package must own Limina-governed source modules.',
  });
}

function storeEntryPatterns(options: {
  context: UnusedModuleConfigContext;
  ownerName: string;
  patterns: string[];
}): void {
  if (options.patterns.length === 0) return;
  options.context.entryPatternsByOwnerName.set(
    options.ownerName,
    uniqueSortedStrings(options.patterns),
  );
}

function collectConfiguredEntries(options: {
  context: UnusedModuleConfigContext;
  ownerName: string;
  rawEntries: unknown[];
  workspaceField: string;
}): string[] {
  return options.rawEntries.flatMap((entry, index) =>
    collectEntryPatterns({
      context: options.context,
      entry,
      field: `${options.workspaceField}.entry[${index}]`,
      ownerName: options.ownerName,
    }),
  );
}

function getConfiguredEntries(
  options: WorkspaceUnusedConfigOptions,
): unknown[] | null {
  const rawEntries = options.workspaceConfig.entry;
  if (rawEntries === undefined) return null;
  if (Array.isArray(rawEntries)) return rawEntries;
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  addEntryFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(rawEntries)}`],
    field: `${workspaceField}.entry`,
    ownerName: options.ownerName,
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
  if (!options.context.moduleSetByOwnerName.has(options.ownerName)) {
    addMissingOwnerFinding(options);
    return;
  }
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  storeEntryPatterns({
    context: options.context,
    ownerName: options.ownerName,
    patterns: collectConfiguredEntries({
      context: options.context,
      ownerName: options.ownerName,
      rawEntries,
      workspaceField,
    }),
  });
}
