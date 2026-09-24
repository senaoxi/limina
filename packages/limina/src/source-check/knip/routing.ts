import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
} from '../../core/workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { KnipSourceAnalysisGroup } from '../knip';

export {
  collectSourceKnipWorkspaceConfigs,
  formatSourceKnipWorkspaceField,
  type SourceKnipWorkspaceConfigRecord,
} from './workspace-config';

interface VirtualKnipConfig {
  extends?: unknown;
  references?: readonly { readonly path?: unknown }[];
}

export function createKnipSourceAnalysisGroups(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  requiredOwnerIdentities: Set<PackageOwnerIdentity>;
  workspacePackages: WorkspacePackage[];
  workspaceContext: ValidatedWorkspaceContext;
}): KnipSourceAnalysisGroup[] {
  const groups = options.workspacePackages.flatMap((workspacePackage) =>
    createPackageGroups({ ...options, workspacePackage }),
  );
  const defaultNames = groups
    .filter((group) => group.tsConfigFile === undefined)
    .flatMap((group) => group.workspaceNames ?? []);
  const defaults =
    defaultNames.length === 0 ? [] : [{ workspaceNames: defaultNames }];
  return [
    ...defaults,
    ...groups.filter((group) => group.tsConfigFile !== undefined),
  ];
}

function createPackageGroups(
  options: Parameters<typeof createKnipSourceAnalysisGroups>[0] & {
    workspacePackage: WorkspacePackage;
  },
): KnipSourceAnalysisGroup[] {
  const { workspacePackage } = options;
  const identity = getPackageOwnerIdentity(
    options.workspaceContext,
    workspacePackage.directory,
  );
  if (!options.requiredOwnerIdentities.has(identity)) return [];
  const workspaceNames = [
    toRelativePath(
      options.config.governanceRoot.rootDir,
      workspacePackage.directory,
    ),
  ];
  const generated = options.generatedGraph.generatedKnipConfigs.find(
    (entry) =>
      getPackageOwnerIdentity(
        options.workspaceContext,
        entry.packageDirectory,
      ) === identity,
  );
  if (generated === undefined) return [{ workspaceNames }];
  return collectRealKnipConfigReferences(
    generated.references,
    options.generatedGraph.generatedFiles,
  ).map((reference) => ({
    tsConfigFile: toRelativePath(workspacePackage.directory, reference),
    workspaceNames,
  }));
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
