import { compareCodeUnits } from '#utils/collections';
import path from 'pathe';
import {
  type DeclarationProviderResolution,
  resolveDeclarationProvider,
} from '../import-graph/declaration-provider';
import { formatOxcOnlyDeclarationProviderProblem } from './provider-problems';
import { formatReferenceBoundaryProblem } from './reference-boundary';
import type {
  ReferenceImportOptions,
  ReferenceTarget,
  ResolvedProvider,
} from './reference-import-types';
import { isLocalPathOutsideActivatedRegions } from './source-projects';

function addOxcOnlyProblem(options: {
  base: ReferenceImportOptions;
  provider: DeclarationProviderResolution;
}): boolean {
  if (options.provider.kind !== 'oxc-only') {
    return false;
  }
  options.base.context.problems.push(
    formatOxcOnlyDeclarationProviderProblem({
      config: options.base.context.config,
      importRecord: options.base.importRecord,
      oxcResolvedFilePath: options.provider.oxcResolvedFilePath,
      project: options.base.project,
    }),
  );
  return true;
}

function isResolvedProvider(
  provider: DeclarationProviderResolution,
): provider is ResolvedProvider {
  return provider.kind === 'declaration' || provider.kind === 'source';
}

export function resolveUsableProvider(
  options: ReferenceImportOptions,
): ResolvedProvider | null {
  const provider = resolveDeclarationProvider({
    compilerOptions: options.project.options,
    containingFile: options.fileName,
    fileOwnerLookup: options.context.fileOwnerLookup,
    importAnalysis: options.context.importAnalysis,
    importRecord: options.importRecord,
    project: {
      ...options.project.context,
      configPath: options.project.configPath,
      resolverConfigPath: options.project.configPath,
    },
  });
  if (addOxcOnlyProblem({ base: options, provider })) {
    return null;
  }
  return isResolvedProvider(provider) ? provider : null;
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

function resolveDeclarationTarget(options: {
  base: ReferenceImportOptions;
  resolvedFilePath: string;
}): ReferenceTarget | null {
  const attribution = options.base.context.managedOutputLookup.resolve(
    options.resolvedFilePath,
    options.base.project.checkerName,
  );
  if (!attribution) {
    return null;
  }
  return {
    providerSourceFilePath: attribution.mappedSourceFilePath,
    resolvedFilePath: options.resolvedFilePath,
    targetSourceConfigPath: attribution.sourceConfigPath,
  };
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
  provider: ResolvedProvider;
}): ReferenceTarget | null {
  const resolvedFilePath =
    options.provider.typeScriptResolution.resolvedFileName;
  if (options.provider.kind === 'declaration') {
    return resolveDeclarationTarget({ base: options.base, resolvedFilePath });
  }
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
  return resolveProviderTarget(options);
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
