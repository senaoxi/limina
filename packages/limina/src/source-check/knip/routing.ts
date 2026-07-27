import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import type { KnipSourceAnalysisGroup } from '../knip';

export {
  collectSourceKnipWorkspaceConfigs,
  formatSourceKnipWorkspaceField,
  type SourceKnipWorkspaceConfigRecord,
} from './workspace-config';

interface GeneratedKnipConfig {
  packageName?: string | null;
  references: readonly string[];
}

interface PackageGroupSelection {
  defaultWorkspaceName?: string;
  groups: KnipSourceAnalysisGroup[];
}

interface VirtualKnipConfig {
  extends?: unknown;
  references?: readonly { readonly path?: unknown }[];
}

function createGeneratedConfigMap(
  entries: readonly GeneratedKnipConfig[],
): Map<string, GeneratedKnipConfig> {
  const generatedConfigByPackageName = new Map<string, GeneratedKnipConfig>();

  for (const entry of entries) {
    if (typeof entry.packageName === 'string') {
      generatedConfigByPackageName.set(entry.packageName, entry);
    }
  }

  return generatedConfigByPackageName;
}

function isRequiredWorkspacePackage(options: {
  requiredWorkspaceNames: ReadonlySet<string>;
  workspacePackage: WorkspacePackage & { name: string };
}): boolean {
  return options.requiredWorkspaceNames.has(options.workspacePackage.name);
}

function createReferenceGroups(options: {
  generatedConfig: GeneratedKnipConfig;
  generatedFiles: ReadonlyMap<string, string>;
  workspacePackage: WorkspacePackage & { name: string };
}): KnipSourceAnalysisGroup[] {
  return collectRealKnipConfigReferences(
    options.generatedConfig.references,
    options.generatedFiles,
  ).map((reference) => ({
    tsConfigFile: toRelativePath(options.workspacePackage.directory, reference),
    workspaceNames: [options.workspacePackage.name],
  }));
}

function selectPackageGroup(options: {
  generatedConfigByPackageName: ReadonlyMap<string, GeneratedKnipConfig>;
  generatedFiles: ReadonlyMap<string, string>;
  requiredWorkspaceNames: ReadonlySet<string>;
  workspacePackage: WorkspacePackage & { name: string };
}): PackageGroupSelection | null {
  if (!isRequiredWorkspacePackage(options)) {
    return null;
  }

  const generatedConfig = options.generatedConfigByPackageName.get(
    options.workspacePackage.name,
  );

  if (generatedConfig === undefined) {
    return {
      defaultWorkspaceName: options.workspacePackage.name,
      groups: [],
    };
  }

  return {
    groups: createReferenceGroups({
      generatedConfig,
      generatedFiles: options.generatedFiles,
      workspacePackage: options.workspacePackage,
    }),
  };
}

function isPackageGroupSelection(
  selection: PackageGroupSelection | null,
): selection is PackageGroupSelection {
  return selection !== null;
}

function getDefaultWorkspaceNames(
  selections: readonly PackageGroupSelection[],
): string[] {
  return selections
    .map((selection) => selection.defaultWorkspaceName)
    .filter((name): name is string => name !== undefined);
}

function createDefaultGroup(
  workspaceNames: readonly string[],
): KnipSourceAnalysisGroup[] {
  return workspaceNames.length === 0
    ? []
    : [{ workspaceNames: [...workspaceNames] }];
}

export function createKnipSourceAnalysisGroups(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  requiredWorkspaceNames: Set<string>;
  workspacePackages: WorkspacePackage[];
}): KnipSourceAnalysisGroup[] {
  if (options.workspacePackages.length === 0) {
    return [{}];
  }

  const generatedConfigByPackageName = createGeneratedConfigMap(
    options.generatedGraph.generatedKnipConfigs,
  );
  const selections = options.workspacePackages
    .filter(isNamedWorkspacePackage)
    .map((workspacePackage) =>
      selectPackageGroup({
        generatedConfigByPackageName,
        generatedFiles: options.generatedGraph.generatedFiles,
        requiredWorkspaceNames: options.requiredWorkspaceNames,
        workspacePackage,
      }),
    )
    .filter(isPackageGroupSelection);
  const defaultWorkspaceNames = getDefaultWorkspaceNames(selections);

  return [
    ...createDefaultGroup(defaultWorkspaceNames),
    ...selections.flatMap((selection) => selection.groups),
  ];
}

function parseVirtualConfig(content: string): VirtualKnipConfig {
  return JSON.parse(content) as VirtualKnipConfig;
}

function resolveConfigReference(configPath: string, reference: string): string {
  return normalizeAbsolutePath(
    path.resolve(path.dirname(configPath), reference),
  );
}

function appendExtendedConfig(
  pending: string[],
  configPath: string,
  extendedConfig: unknown,
): void {
  if (typeof extendedConfig === 'string') {
    pending.push(resolveConfigReference(configPath, extendedConfig));
  }
}

function getConfigReferences(
  config: VirtualKnipConfig,
): readonly { readonly path?: unknown }[] {
  return config.references === undefined ? [] : config.references;
}

function appendReferencedConfigs(
  pending: string[],
  configPath: string,
  config: VirtualKnipConfig,
): void {
  for (const reference of getConfigReferences(config)) {
    if (typeof reference.path === 'string') {
      pending.push(resolveConfigReference(configPath, reference.path));
    }
  }
}

function processConfigPath(options: {
  configPath: string;
  pending: string[];
  realReferences: Set<string>;
  seen: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): void {
  if (options.seen.has(options.configPath)) {
    return;
  }

  options.seen.add(options.configPath);
  const content = options.virtualFiles.get(options.configPath);

  if (content === undefined) {
    options.realReferences.add(options.configPath);
    return;
  }

  const config = parseVirtualConfig(content);
  appendExtendedConfig(options.pending, options.configPath, config.extends);
  appendReferencedConfigs(options.pending, options.configPath, config);
}

function collectRealKnipConfigReferences(
  references: readonly string[],
  virtualFiles: ReadonlyMap<string, string>,
): string[] {
  const realReferences = new Set<string>();
  const seen = new Set<string>();
  const pending = references.map(normalizeAbsolutePath);

  for (const configPath of pending) {
    processConfigPath({
      configPath,
      pending,
      realReferences,
      seen,
      virtualFiles,
    });
  }

  return [...realReferences].sort();
}
