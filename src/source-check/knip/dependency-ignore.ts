import type { WorkspacePackage } from '#core/workspace/actions';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import {
  createWorkspaceDependencyKey,
  type WorkspaceDependencyDeclaration,
} from '../../core/packages/authority';
import type { PackageOwnerIdentity } from '../../core/workspace/owner-identity';
import type { SourceFinding } from '../findings';
import {
  createContext,
  type DependencyIgnoreContext,
  getPackageJsonPath,
  type ParsedDependencyIgnore,
} from './dependency-ignore-context';
import type { SourceKnipWorkspaceConfigRecord } from './routing';
import { addKnipConfigFinding } from './unused/finding';

export { createPackageDependencyIssueKey } from './dependency-key';

function addInvalidIgnore(options: {
  context: DependencyIgnoreContext;
  details: readonly string[];
  field: string;
  importerIdentity: PackageOwnerIdentity;
  reason: string;
  value?: unknown;
}): void {
  addKnipConfigFinding({
    details: options.details,
    field: options.field,
    findings: options.context.findings,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(
      options.context,
      options.importerIdentity,
    ),
    packageName: options.context.configs.get(options.importerIdentity)?.owner
      .name,
    reason: options.reason,
    title: 'Invalid source Knip dependency ignore config',
    value: options.value,
  });
}

function parseDependencyName(options: {
  context: DependencyIgnoreContext;
  field: string;
  importerIdentity: PackageOwnerIdentity;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addInvalidIgnore({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.dep`,
    importerIdentity: options.importerIdentity,
    reason: 'dep must be a non-empty workspace package name.',
    value: options.value,
  });
  return null;
}

function parseReason(options: {
  context: DependencyIgnoreContext;
  field: string;
  importerIdentity: PackageOwnerIdentity;
  value: unknown;
}): string | null {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }
  addInvalidIgnore({
    context: options.context,
    details: [`  value: ${formatUnknownValue(options.value)}`],
    field: `${options.field}.reason`,
    importerIdentity: options.importerIdentity,
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
  importerIdentity: PackageOwnerIdentity;
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
      importerIdentity: options.importerIdentity,
      value: options.entry.dep,
    }),
    reason: parseReason({
      context: options.context,
      field: options.field,
      importerIdentity: options.importerIdentity,
      value: options.entry.reason,
    }),
  });
}

function addUnknownDependencyFinding(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerIdentity: PackageOwnerIdentity;
}): void {
  addKnipConfigFinding({
    dependencyName: options.dependencyName,
    details: [`  dep: ${options.dependencyName}`],
    field: `${options.field}.dep`,
    findings: options.context.findings,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(
      options.context,
      options.importerIdentity,
    ),
    packageName: options.context.configs.get(options.importerIdentity)?.owner
      .name,
    reason: 'dep must name a package from the workspace.',
    title: 'Invalid source Knip dependency ignore config',
  });
}

function addUndeclaredDependencyFinding(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerIdentity: PackageOwnerIdentity;
}): void {
  const owner = options.context.configs.get(options.importerIdentity)!.owner;
  addKnipConfigFinding({
    dependencyName: options.dependencyName,
    details: [
      `  importer: ${owner.name ?? getPackageJsonPath(options.context, options.importerIdentity)}`,
      `  dep: ${options.dependencyName}`,
    ],
    field: options.field,
    findings: options.context.findings,
    importerName: owner.name,
    kind: 'dependency-ignore',
    packageJsonPath: getPackageJsonPath(
      options.context,
      options.importerIdentity,
    ),
    packageName: owner.name,
    reason:
      'ignoreDependencies entries must match a workspace dependency declared by the keyed importer package manifest.',
    title: 'Invalid source Knip dependency ignore config',
  });
}

function validateDependencyIgnore(options: {
  context: DependencyIgnoreContext;
  dependencyName: string;
  field: string;
  importerIdentity: PackageOwnerIdentity;
}): string | null {
  if (!options.context.workspacePackageNames.has(options.dependencyName)) {
    addUnknownDependencyFinding(options);
    return null;
  }
  const key = createWorkspaceDependencyKey(
    options.importerIdentity,
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
  importerIdentity: PackageOwnerIdentity;
  rawIgnore: unknown;
}): string[] {
  const workspaceField = options.context.configs.get(
    options.importerIdentity,
  )!.field;
  if (!Array.isArray(options.rawIgnore)) {
    addInvalidIgnore({
      context: options.context,
      details: [`  value: ${formatUnknownValue(options.rawIgnore)}`],
      field: `${workspaceField}.ignoreDependencies`,
      importerIdentity: options.importerIdentity,
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
      importerIdentity: options.importerIdentity,
    });
    if (parsed === null) return [];
    const key = validateDependencyIgnore({
      context: options.context,
      dependencyName: parsed.dependencyName,
      field,
      importerIdentity: options.importerIdentity,
    });
    return key === null ? [] : [key];
  });
}

function collectConfiguredWorkspaceIgnores(options: {
  context: DependencyIgnoreContext;
  importerIdentity: PackageOwnerIdentity;
  workspaceConfig: SourceKnipWorkspaceConfigRecord;
}): string[] {
  const rawIgnore = options.workspaceConfig.ignoreDependencies;
  if (rawIgnore === undefined) return [];
  return collectWorkspaceIgnores({ ...options, rawIgnore });
}

export function collectUnusedDependencyIgnore(options: {
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  knipWorkspaceConfigs: Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >;
  workspacePackages: WorkspacePackage[];
}): Set<string> {
  const context = createContext(options);
  const ignoredKeys = new Set<string>();
  for (const [
    importerIdentity,
    workspaceConfig,
  ] of options.knipWorkspaceConfigs) {
    const keys = collectConfiguredWorkspaceIgnores({
      context,
      importerIdentity,
      workspaceConfig,
    });
    for (const key of keys) ignoredKeys.add(key);
  }
  return ignoredKeys;
}
