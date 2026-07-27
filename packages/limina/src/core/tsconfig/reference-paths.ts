import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { formatUnknownValue } from '#utils/values';
import type {
  JsonObject,
  ReferencePathCollection,
  ReferencePathInfo,
  TsconfigGraphRouteDiagnostic,
} from './action-types';
import { readJsonConfigFile, resolveReferencePath } from './config-paths';

interface ReferenceCollectionState {
  diagnostics: TsconfigGraphRouteDiagnostic[];
  problems: string[];
  references: ReferencePathInfo[];
}

export function addTsconfigGraphRouteProblem(options: {
  detailLines: readonly string[];
  diagnostics: TsconfigGraphRouteDiagnostic[];
  filePath?: string;
  problems: string[];
  reason: string;
  title: string;
}): void {
  options.problems.push(options.detailLines.join('\n'));
  options.diagnostics.push({
    detailLines: options.detailLines,
    filePath: options.filePath,
    reason: options.reason,
    title: options.title,
  });
}

function createCollectionState(): ReferenceCollectionState {
  return { diagnostics: [], problems: [], references: [] };
}

function addInvalidReferencesField(options: {
  configPath: string;
  references: unknown;
  rootDir: string;
  state: ReferenceCollectionState;
}): void {
  const reason =
    'references must be an array of objects with a non-empty string path.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Invalid tsconfig references field:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      '  field: references',
      `  value: ${formatUnknownValue(options.references)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: options.state.diagnostics,
    filePath: options.configPath,
    problems: options.state.problems,
    reason,
    title: 'Invalid tsconfig references field',
  });
}

function isReferenceRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return !Array.isArray(value);
}

function addInvalidReferenceEntry(options: {
  configPath: string;
  field: string;
  reference: unknown;
  rootDir: string;
  state: ReferenceCollectionState;
}): void {
  const reason =
    'each reference entry must be an object with a non-empty string path.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Invalid tsconfig reference entry:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      `  field: ${options.field}`,
      `  value: ${formatUnknownValue(options.reference)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: options.state.diagnostics,
    filePath: options.configPath,
    problems: options.state.problems,
    reason,
    title: 'Invalid tsconfig reference entry',
  });
}

function isNonEmptyPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function addInvalidReferencePath(options: {
  configPath: string;
  field: string;
  pathValue: unknown;
  rootDir: string;
  state: ReferenceCollectionState;
}): void {
  const reason = 'reference path must be a non-empty string.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Invalid tsconfig reference path:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      `  field: ${options.field}.path`,
      `  value: ${formatUnknownValue(options.pathValue)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: options.state.diagnostics,
    filePath: options.configPath,
    problems: options.state.problems,
    reason,
    title: 'Invalid tsconfig reference path',
  });
}

function collectReferenceEntry(options: {
  configPath: string;
  field: string;
  reference: unknown;
  rootDir: string;
  state: ReferenceCollectionState;
}): void {
  if (!isReferenceRecord(options.reference)) {
    addInvalidReferenceEntry(options);
    return;
  }
  const pathValue = options.reference.path;
  if (!isNonEmptyPath(pathValue)) {
    addInvalidReferencePath({ ...options, pathValue });
    return;
  }
  options.state.references.push({
    rawPath: pathValue,
    resolvedPath: resolveReferencePath(options.configPath, pathValue),
  });
}

function collectReferenceArray(options: {
  configPath: string;
  references: readonly unknown[];
  rootDir: string;
  state: ReferenceCollectionState;
}): void {
  for (const [index, reference] of options.references.entries()) {
    collectReferenceEntry({
      configPath: options.configPath,
      field: `references[${index}]`,
      reference,
      rootDir: options.rootDir,
      state: options.state,
    });
  }
}

export function collectReferencePathInfosFromConfigObject(
  rootDir: string,
  configPath: string,
  configObject: JsonObject,
): ReferencePathCollection {
  const state = createCollectionState();
  const references = configObject.references;
  if (references === undefined) {
    return state;
  }
  if (!Array.isArray(references)) {
    addInvalidReferencesField({ configPath, references, rootDir, state });
    return state;
  }
  collectReferenceArray({ configPath, references, rootDir, state });
  return state;
}

export function collectReferencePathInfosForConfig(
  rootDir: string,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): ReferencePathCollection {
  return collectReferencePathInfosFromConfigObject(
    rootDir,
    configPath,
    readJsonConfigFile(rootDir, configPath, virtualFiles),
  );
}

export function getRawReferencePaths(
  config: ResolvedLiminaConfig,
  configPath: string,
): string[] {
  return getRawReferencePathsForConfig(config.rootDir, configPath);
}

export function getRawReferencePathsForConfig(
  rootDir: string,
  configPath: string,
): string[] {
  return collectReferencePathInfosForConfig(rootDir, configPath).references.map(
    (reference) => reference.resolvedPath,
  );
}
