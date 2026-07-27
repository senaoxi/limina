import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  createWorkspaceDependencyKey,
  type WorkspaceDependencyDeclaration,
} from '../../core/packages/authority';
import type { SourceFinding } from '../findings';
import type { SourceKnipWorkspaceConfigRecord } from './routing';
import { formatSourceKnipWorkspaceField } from './routing';
import { addKnipConfigFinding } from './unused/finding';

export { createPackageDependencyIssueKey } from './dependency-key';

interface DependencyIgnoreContext {
  declarationKeys: Set<string>;
  findings: SourceFinding[];
  packageJsonPathByImporterName: Map<string, string>;
  workspacePackageNames: Set<string>;
}

interface ParsedDependencyIgnore {
  dependencyName: string;
  reason: string;
}

function createContext(options: {
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  workspacePackages: WorkspacePackage[];
}): DependencyIgnoreContext {
  const namedPackages = options.workspacePackages.filter(
    isNamedWorkspacePackage,
  );
  return {
    declarationKeys: new Set(
      options.declarations.map((declaration) =>
        createWorkspaceDependencyKey(
          declaration.importer.name,
          declaration.dependencyName,
        ),
      ),
    ),
    findings: options.findings,
    packageJsonPathByImporterName: new Map(
      namedPackages.map((entry) => [
        entry.name,
        normalizeAbsolutePath(path.join(entry.directory, 'package.json')),
      ]),
    ),
    workspacePackageNames: new Set(namedPackages.map((entry) => entry.name)),
  };
}

function getPackageJsonPath(
  context: DependencyIgnoreContext,
  importerName: string,
): string | undefined {
  return context.packageJsonPathByImporterName.get(importerName);
}

function addInvalidIgnore(options: {
  context: DependencyIgnoreContext;
  details: readonly string[];
  field: string;
  importerName: string;
  reason: string;
  value?: unknown;
}): void {
  addKnipConfigFinding({
    details: options.details,
    field: options.field,
    findings: options.context.findings,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(options.context, options.importerName),
    packageName: options.importerName,
    reason: options.reason,
    title: 'Invalid source Knip dependency ignore config',
    value: options.value,
  });
}

function parseDependencyName(options: {
  context: DependencyIgnoreContext;
  field: string;
  importerName: string;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addInvalidIgnore({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.dep`,
    importerName: options.importerName,
    reason: 'dep must be a non-empty workspace package name.',
    value: options.value,
  });
  return null;
}

function parseReason(options: {
  context: DependencyIgnoreContext;
  field: string;
  importerName: string;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addInvalidIgnore({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.reason`,
    importerName: options.importerName,
    reason: 'reason must be a non-empty string.',
    value: options.value,
  });
  return null;
}

function createParsedDependencyIgnore(options: {
  dependencyName: string | null;
  reason: string | null;
}): ParsedDependencyIgnore | null {
  if (options.dependencyName === null) return null;
  if (options.reason === null) return null;
  return {
    dependencyName: options.dependencyName,
    reason: options.reason,
  };
}

function parseDependencyIgnoreEntry(options: {
  context: DependencyIgnoreContext;
  entry: unknown;
  field: string;
  importerName: string;
}): ParsedDependencyIgnore | null {
  if (!isPlainRecord(options.entry)) {
    addInvalidIgnore({
      ...options,
      details: [`  value: ${formatUnknownValue(options.entry)}`],
      reason:
        'ignoreDependencies entries must be objects with non-empty dep and reason fields.',
      value: options.entry,
    });
    return null;
  }
  return createParsedDependencyIgnore({
    dependencyName: parseDependencyName({
      context: options.context,
      field: options.field,
      importerName: options.importerName,
      value: options.entry.dep,
    }),
    reason: parseReason({
      context: options.context,
      field: options.field,
      importerName: options.importerName,
      value: options.entry.reason,
    }),
  });
}

function addUnknownDependencyFinding(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerName: string;
}): void {
  addKnipConfigFinding({
    dependencyName: options.dependencyName,
    details: [`  dep: ${options.dependencyName}`],
    field: `${options.field}.dep`,
    findings: options.context.findings,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(options.context, options.importerName),
    packageName: options.importerName,
    reason: 'dep must name a package from the pnpm workspace.',
    title: 'Invalid source Knip dependency ignore config',
  });
}

function addUndeclaredDependencyFinding(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerName: string;
}): void {
  addKnipConfigFinding({
    dependencyName: options.dependencyName,
    details: [
      `  importer: ${options.importerName}`,
      `  dep: ${options.dependencyName}`,
    ],
    field: options.field,
    findings: options.context.findings,
    importerName: options.importerName,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(options.context, options.importerName),
    packageName: options.importerName,
    reason:
      'ignoreDependencies entries must match a workspace dependency declared by the keyed importer package manifest.',
    title: 'Invalid source Knip dependency ignore config',
  });
}

function validateDependencyIgnore(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerName: string;
}): string | null {
  if (!options.context.workspacePackageNames.has(options.dependencyName)) {
    addUnknownDependencyFinding(options);
    return null;
  }
  const key = createWorkspaceDependencyKey(
    options.importerName,
    options.dependencyName,
  );
  if (!options.context.declarationKeys.has(key)) {
    addUndeclaredDependencyFinding(options);
    return null;
  }
  return key;
}

function collectWorkspaceIgnores(options: {
  context: DependencyIgnoreContext;
  importerName: string;
  rawIgnore: unknown;
}): string[] {
  const workspaceField = formatSourceKnipWorkspaceField(options.importerName);
  if (!Array.isArray(options.rawIgnore)) {
    addInvalidIgnore({
      context: options.context,
      details: [`  value: ${formatUnknownValue(options.rawIgnore)}`],
      field: `${workspaceField}.ignoreDependencies`,
      importerName: options.importerName,
      reason: 'ignoreDependencies must be an array.',
      value: options.rawIgnore,
    });
    return [];
  }
  return options.rawIgnore.flatMap((entry, index) => {
    const field = `${workspaceField}.ignoreDependencies[${index}]`;
    const parsed = parseDependencyIgnoreEntry({
      context: options.context,
      entry,
      field,
      importerName: options.importerName,
    });
    if (parsed === null) return [];
    const key = validateDependencyIgnore({
      context: options.context,
      dependencyName: parsed.dependencyName,
      field,
      importerName: options.importerName,
    });
    return key === null ? [] : [key];
  });
}

function collectConfiguredWorkspaceIgnores(options: {
  context: DependencyIgnoreContext;
  importerName: string;
  workspaceConfig: SourceKnipWorkspaceConfigRecord;
}): string[] {
  const rawIgnore = options.workspaceConfig.ignoreDependencies;
  if (rawIgnore === undefined) return [];
  return collectWorkspaceIgnores({ ...options, rawIgnore });
}

export function collectUnusedDependencyIgnore(options: {
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  workspacePackages: WorkspacePackage[];
}): Set<string> {
  const context = createContext(options);
  const ignoredKeys = new Set<string>();
  for (const [importerName, workspaceConfig] of options.knipWorkspaceConfigs) {
    const keys = collectConfiguredWorkspaceIgnores({
      context,
      importerName,
      workspaceConfig,
    });
    for (const key of keys) ignoredKeys.add(key);
  }
  return ignoredKeys;
}
