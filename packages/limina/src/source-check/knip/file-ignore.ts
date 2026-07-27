import { normalizeAbsolutePath, normalizeSlashes } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import { formatSourceKnipWorkspaceField } from './routing';
import type {
  UnusedModuleConfigContext,
  WorkspaceUnusedConfigOptions,
} from './unused/config-types';
import { addKnipConfigFinding } from './unused/finding';
import { createOwnerSourceFileKey } from './unused/keys';

interface ParsedFileIgnore {
  file: string;
  reason: string;
}

function addFileIgnoreFinding(options: {
  context: UnusedModuleConfigContext;
  details: readonly string[];
  field: string;
  file?: string;
  ownerName: string;
  reason: string;
  value?: unknown;
}): void {
  const moduleSet = options.context.moduleSetByOwnerName.get(options.ownerName);
  addKnipConfigFinding({
    details: options.details,
    field: options.field,
    file: options.file,
    findings: options.context.findings,
    kind: 'file-ignore',
    packageJsonPath: moduleSet?.owner.packageJsonPath,
    packageName: options.ownerName,
    reason: options.reason,
    title: 'Invalid source Knip file ignore config',
    value: options.value,
  });
}

function parseFileValue(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return normalizeSlashes(options.value.trim());
  }
  addFileIgnoreFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.file`,
    ownerName: options.ownerName,
    reason: 'file must be a non-empty config-root-relative path.',
    value: options.value,
  });
  return null;
}

function parseReasonValue(options: {
  context: UnusedModuleConfigContext;
  field: string;
  ownerName: string;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addFileIgnoreFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.reason`,
    ownerName: options.ownerName,
    reason: 'reason must be a non-empty string.',
    value: options.value,
  });
  return null;
}

function createParsedFileIgnore(options: {
  file: string | null;
  reason: string | null;
}): ParsedFileIgnore | null {
  if (options.file === null) return null;
  if (options.reason === null) return null;
  return { file: options.file, reason: options.reason };
}

function parseIgnoreRecord(options: {
  context: UnusedModuleConfigContext;
  entry: unknown;
  field: string;
  ownerName: string;
}): ParsedFileIgnore | null {
  if (!isPlainRecord(options.entry)) {
    addFileIgnoreFinding({
      ...options,
      details: [`  value: ${formatUnknownValue(options.entry)}`],
      reason:
        'ignoreFiles entries must be objects with non-empty file and reason fields.',
      value: options.entry,
    });
    return null;
  }
  return createParsedFileIgnore({
    file: parseFileValue({
      context: options.context,
      field: options.field,
      ownerName: options.ownerName,
      value: options.entry.file,
    }),
    reason: parseReasonValue({
      context: options.context,
      field: options.field,
      ownerName: options.ownerName,
      value: options.entry.reason,
    }),
  });
}

function isAbsoluteFile(file: string): boolean {
  return path.isAbsolute(file) || /^[A-Za-z]:[\\/]/u.test(file);
}

function addAbsoluteFileFinding(options: {
  context: UnusedModuleConfigContext;
  field: string;
  file: string;
  ownerName: string;
}): void {
  addFileIgnoreFinding({
    context: options.context,
    details: [`  file: ${options.file}`],
    field: `${options.field}.file`,
    file: options.file,
    ownerName: options.ownerName,
    reason: 'file must be relative to config.rootDir.',
  });
}

function addUnknownFileFinding(options: {
  context: UnusedModuleConfigContext;
  field: string;
  file: string;
  ownerName: string;
}): void {
  addFileIgnoreFinding({
    context: options.context,
    details: [`  package: ${options.ownerName}`, `  file: ${options.file}`],
    field: `${options.field}.file`,
    file: options.file,
    ownerName: options.ownerName,
    reason:
      'file must belong to the keyed package source module set known to Limina.',
  });
}

function ownerContainsFile(options: {
  context: UnusedModuleConfigContext;
  filePath: string;
  ownerName: string;
}): boolean {
  const ownerFiles = options.context.moduleFilesByOwnerName.get(
    options.ownerName,
  );
  if (ownerFiles === undefined) return false;
  return ownerFiles.has(options.filePath);
}

function validateOwnedFilePath(options: {
  context: UnusedModuleConfigContext;
  field: string;
  file: string;
  filePath: string;
  ownerName: string;
}): string | null {
  if (ownerContainsFile(options)) return options.filePath;
  addUnknownFileFinding(options);
  return null;
}

function validateFilePath(options: {
  context: UnusedModuleConfigContext;
  field: string;
  file: string;
  ownerName: string;
}): string | null {
  if (isAbsoluteFile(options.file)) {
    addAbsoluteFileFinding(options);
    return null;
  }
  const filePath = normalizeAbsolutePath(
    path.resolve(options.context.config.rootDir, options.file),
  );
  return validateOwnedFilePath({ ...options, filePath });
}

function collectIgnoreKey(options: {
  context: UnusedModuleConfigContext;
  entry: unknown;
  field: string;
  ownerName: string;
}): string | null {
  const parsed = parseIgnoreRecord(options);
  if (parsed === null) return null;
  const filePath = validateFilePath({
    context: options.context,
    field: options.field,
    file: parsed.file,
    ownerName: options.ownerName,
  });
  if (filePath === null) return null;
  return createOwnerSourceFileKey(options.ownerName, filePath);
}

function addMissingOwnerFinding(options: WorkspaceUnusedConfigOptions): void {
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  addFileIgnoreFinding({
    context: options.context,
    details: [`  package: ${options.ownerName}`],
    field: `${workspaceField}.ignoreFiles`,
    ownerName: options.ownerName,
    reason: 'package must own Limina-governed source modules.',
  });
}

function collectIgnoreKeys(options: {
  context: UnusedModuleConfigContext;
  ownerName: string;
  rawIgnore: unknown[];
  workspaceField: string;
}): string[] {
  return options.rawIgnore.flatMap((entry, index) => {
    const key = collectIgnoreKey({
      context: options.context,
      entry,
      field: `${options.workspaceField}.ignoreFiles[${index}]`,
      ownerName: options.ownerName,
    });
    return key === null ? [] : [key];
  });
}

function storeIgnoreKeys(
  context: UnusedModuleConfigContext,
  keys: readonly string[],
): void {
  for (const key of keys) context.ignoredKeys.add(key);
}

function getConfiguredFileIgnores(
  options: WorkspaceUnusedConfigOptions,
): unknown[] | null {
  const rawIgnore = options.workspaceConfig.ignoreFiles;
  if (rawIgnore === undefined) return null;
  if (Array.isArray(rawIgnore)) return rawIgnore;
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  addFileIgnoreFinding({
    context: options.context,
    details: [`  value: ${formatUnknownValue(rawIgnore)}`],
    field: `${workspaceField}.ignoreFiles`,
    ownerName: options.ownerName,
    reason: 'ignoreFiles must be an array.',
    value: rawIgnore,
  });
  return null;
}

export function collectWorkspaceFileIgnoreConfig(
  options: WorkspaceUnusedConfigOptions,
): void {
  const rawIgnore = getConfiguredFileIgnores(options);
  if (rawIgnore === null) return;
  if (!options.context.moduleSetByOwnerName.has(options.ownerName)) {
    addMissingOwnerFinding(options);
    return;
  }
  const workspaceField = formatSourceKnipWorkspaceField(options.ownerName);
  storeIgnoreKeys(
    options.context,
    collectIgnoreKeys({
      context: options.context,
      ownerName: options.ownerName,
      rawIgnore,
      workspaceField,
    }),
  );
}
