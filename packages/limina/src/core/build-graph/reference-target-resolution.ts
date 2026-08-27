import { compareCodeUnits } from '#utils/collections';
import { isRelativeSpecifier } from '#utils/module-specifier';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import { getDtsProjectsForSourcePath } from './project-indexes';
import { formatReferenceBoundaryProblem } from './reference-boundary';
import type {
  ReferenceImportOptions,
  ReferenceTarget,
  ResolvedProvider,
} from './reference-import-types';
import { isLocalPathOutsideActivatedRegions } from './source-projects';

const FRAMEWORK_SOURCE_EXTENSIONS = ['.astro', '.svelte', '.vue'];

function isFrameworkSourceDependency(
  dependency: ReferenceImportOptions['projectDependency'],
): boolean {
  if (dependency.targetKind !== 'source') return false;
  const normalized = dependency.resolvedFilePath.toLowerCase();
  return FRAMEWORK_SOURCE_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

function createProjectDependencyTypeScriptResolution(
  dependency: ReferenceImportOptions['projectDependency'],
) {
  return {
    isExternalLibraryImport: false,
    resolvedBy: isFrameworkSourceDependency(dependency)
      ? ('checker-source' as const)
      : ('typescript' as const),
    resolvedFileName: dependency.resolvedFilePath,
  };
}

function resolveProjectDependencyProvider(
  options: ReferenceImportOptions,
): ResolvedProvider {
  const dependency = options.projectDependency;
  const typeScriptResolution =
    createProjectDependencyTypeScriptResolution(dependency);
  if (dependency.targetKind === 'declaration') {
    return {
      kind: 'declaration',
      oxcResolvedFilePath: null,
      typeScriptResolution,
    };
  }
  return {
    kind: 'source',
    ownerProjectPaths:
      options.context.fileOwnerLookup.get(dependency.resolvedFilePath) ?? [],
    oxcResolvedFilePath: null,
    typeScriptResolution,
  };
}

export function resolveUsableProvider(
  options: ReferenceImportOptions,
): ResolvedProvider {
  return resolveProjectDependencyProvider(options);
}

function chooseSourceOwner(options: {
  ownerProjectPaths: string[];
  projectConfigPath: string;
}): string | null {
  const candidates = options.ownerProjectPaths
    .filter((owner) => owner !== options.projectConfigPath)
    .sort(
      (left, right) =>
        path.dirname(right).length - path.dirname(left).length ||
        compareCodeUnits(left, right),
    );
  return candidates[0] ?? null;
}

function resolveExplicitSpecifierPath(
  options: Omit<ReferenceImportOptions, 'projectDependency'>,
): string | null {
  const specifier = options.importRecord.specifier.split(/[?#]/u)[0]!;
  if (!isRelativeSpecifier(specifier)) return null;
  return normalizeAbsolutePath(
    path.resolve(path.dirname(options.fileName), specifier),
  );
}

function getOwnedConfigPaths(
  context: ReferenceImportOptions['context'],
  filePath: string,
): string[] {
  return context.fileOwnerLookup.get(filePath) ?? [];
}

function resolveExplicitOwnedSource(
  options: Omit<ReferenceImportOptions, 'projectDependency'>,
): {
  resolvedFilePath: string;
  targetSourceConfigPath: string;
} | null {
  const resolvedFilePath = resolveExplicitSpecifierPath(options);
  if (resolvedFilePath === null) return null;
  const targetSourceConfigPath = chooseSourceOwner({
    ownerProjectPaths: getOwnedConfigPaths(options.context, resolvedFilePath),
    projectConfigPath: options.project.configPath,
  });
  return targetSourceConfigPath === null
    ? null
    : { resolvedFilePath, targetSourceConfigPath };
}

export function addMissingOwnedDeclarationProviderProblem(
  options: Omit<ReferenceImportOptions, 'projectDependency'>,
): void {
  const target = resolveExplicitOwnedSource(options);
  if (target === null) return;
  const providers = getDtsProjectsForSourcePath({
    dtsProjectsBySourcePath: options.context.dtsProjectsBySourcePath,
    sourceConfigPath: target.targetSourceConfigPath,
  });
  if (providers.length > 0) return;
  options.context.problems.push(
    [
      'Unable to map generated graph import to a declaration provider:',
      `  importing config: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${toRelativePath(options.context.config.rootDir, options.fileName)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, target.resolvedFilePath)}`,
      `  target config: ${toRelativePath(options.context.config.rootDir, target.targetSourceConfigPath)}`,
      '  reason: the imported governed source has no declaration provider; generated solution projections are scheduling-only.',
    ].join('\n'),
  );
}

function resolveSourceTarget(options: {
  base: ReferenceImportOptions;
  provider: Extract<ResolvedProvider, { kind: 'source' }>;
  resolvedFilePath: string;
}): ReferenceTarget | null {
  const targetSourceConfigPath = chooseSourceOwner({
    ownerProjectPaths: options.provider.ownerProjectPaths,
    projectConfigPath: options.base.project.configPath,
  });
  if (!targetSourceConfigPath) {
    return null;
  }
  return {
    providerSourceFilePath: options.resolvedFilePath,
    resolvedFilePath: options.resolvedFilePath,
    targetSourceConfigPath,
  };
}

function resolveProviderTarget(options: {
  base: ReferenceImportOptions;
  provider: Extract<ResolvedProvider, { kind: 'source' }>;
}): ReferenceTarget | null {
  const resolvedFilePath =
    options.provider.typeScriptResolution.resolvedFileName;
  return resolveSourceTarget({
    base: options.base,
    provider: options.provider,
    resolvedFilePath,
  });
}

export function createReferenceTarget(options: {
  base: ReferenceImportOptions;
  provider: ResolvedProvider;
}): ReferenceTarget | null {
  if (options.provider.kind === 'declaration') return null;
  const resolvedFilePath =
    options.provider.typeScriptResolution.resolvedFileName;
  if (
    isLocalPathOutsideActivatedRegions({
      activatedRegions: options.base.context.activatedRegions,
      config: options.base.context.config,
      filePath: resolvedFilePath,
    })
  ) {
    options.base.context.problems.push(
      formatReferenceBoundaryProblem({
        activatedRegions: options.base.context.activatedRegions,
        config: options.base.context.config,
        importRecord: options.base.importRecord,
        project: options.base.project,
        resolvedFilePath,
      }),
    );
    return null;
  }
  return resolveProviderTarget({
    base: options.base,
    provider: options.provider,
  });
}

export function isValidReferenceTarget(
  projectConfigPath: string,
  target: ReferenceTarget | null,
): target is ReferenceTarget {
  if (!target) {
    return false;
  }
  return target.targetSourceConfigPath !== projectConfigPath;
}
