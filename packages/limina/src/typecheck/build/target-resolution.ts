import { getCheckerAdapter } from '#checkers';
import type {
  BuildCheckerPreset,
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import type { LiminaPreflightManager } from '../../preflight';
import { resolvePreflight } from '../../preflight';
import { resolveBuildConfigPath } from './config-path';
import {
  type BuildTargetDescriptor,
  getManagedBuildTargets,
} from './target-descriptors';

export type OutputBuildResolutionKind =
  | 'managed-output'
  | 'outputless-project'
  | 'outputless-solution'
  | 'typecheck-only'
  | 'unmanaged';

export interface ResolveBuildTargetOptions {
  checker?: BuildCheckerPreset;
  config: ResolvedLiminaConfig;
  configPath?: string;
  providers?: AnalysisProviderSet;
  cwd: string;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  project?: string;
  raw?: boolean;
}

export type ResolvedBuildTarget =
  | {
      availableCheckers: string[];
      allCheckers: ResolvedCheckerConfig[];
      checkerTargets: BuildTargetDescriptor[];
      generatedGraph: GeneratedTsconfigGraphResult;
      kind: 'managed';
      matchingCheckers: ResolvedCheckerConfig[];
      resolutionKind: OutputBuildResolutionKind;
      selectedChecker?: BuildCheckerPreset;
      sourceConfigPath: string;
    }
  | {
      checker: BuildCheckerPreset;
      kind: 'raw';
      targetConfigPath: string;
    };

function isBuildCapable(descriptor: BuildTargetDescriptor): boolean {
  return getCheckerAdapter(descriptor.checker.preset)?.execution === 'build';
}

function selectCheckerTargets(options: {
  checker: BuildCheckerPreset | undefined;
  targets: readonly BuildTargetDescriptor[];
}): BuildTargetDescriptor[] {
  if (options.checker === undefined) return [...options.targets];
  return options.targets.filter(
    ({ checker }) => checker.preset === options.checker,
  );
}

function getOutputlessResolutionKind(
  targets: readonly BuildTargetDescriptor[],
): OutputBuildResolutionKind {
  const kinds = uniqueSortedStrings(
    targets.map(({ buildModule }) => buildModule.kind),
  );
  return kinds.includes('solution')
    ? 'outputless-solution'
    : 'outputless-project';
}

function getMissingOutputResolutionKind(options: {
  buildCapableDeclarationTargets: readonly BuildTargetDescriptor[];
  declarationTargets: readonly BuildTargetDescriptor[];
}): OutputBuildResolutionKind {
  if (options.declarationTargets.length === 0) return 'unmanaged';
  if (options.buildCapableDeclarationTargets.length === 0) {
    return 'typecheck-only';
  }
  return getOutputlessResolutionKind(options.buildCapableDeclarationTargets);
}

function getResolutionKind(options: {
  buildCapableDeclarationTargets: readonly BuildTargetDescriptor[];
  checkerTargets: readonly BuildTargetDescriptor[];
  declarationTargets: readonly BuildTargetDescriptor[];
}): OutputBuildResolutionKind {
  if (options.checkerTargets.length > 0) return 'managed-output';
  return getMissingOutputResolutionKind(options);
}

function getSelectedCheckerField(checker: BuildCheckerPreset | undefined): {
  selectedChecker?: BuildCheckerPreset;
} {
  if (checker === undefined) return {};
  return { selectedChecker: checker };
}

function assertRawPreset(options: {
  checker: BuildCheckerPreset | undefined;
  projectRootDir: string;
  targetConfigPath: string;
}): asserts options is {
  checker: BuildCheckerPreset;
  projectRootDir: string;
  targetConfigPath: string;
} {
  if (options.checker !== undefined) return;
  throw new Error(
    [
      'Invalid raw build invocation:',
      `  config: ${toRelativePath(
        options.projectRootDir,
        options.targetConfigPath,
      )}`,
      '  reason: limina build --raw requires --preset.',
    ].join('\n'),
  );
}

function assertRawUserConfig(options: {
  projectRootDir: string;
  targetConfigPath: string;
}): void {
  if (!options.targetConfigPath.split(path.sep).includes('.limina')) return;
  throw new Error(
    [
      'Invalid raw build config:',
      `  config: ${toRelativePath(
        options.projectRootDir,
        options.targetConfigPath,
      )}`,
      '  reason: raw build expects a user-authored tsconfig, not a .limina generated config.',
    ].join('\n'),
  );
}

function resolveRawBuildTarget(options: {
  checker: BuildCheckerPreset | undefined;
  projectRootDir: string;
  targetConfigPath: string;
}): ResolvedBuildTarget {
  assertRawPreset(options);
  assertRawUserConfig(options);
  return {
    checker: options.checker,
    kind: 'raw',
    targetConfigPath: options.targetConfigPath,
  };
}

async function resolveManagedBuildTarget(options: {
  request: ResolveBuildTargetOptions;
  sourceConfigPath: string;
}): Promise<ResolvedBuildTarget> {
  const generatedGraph = (
    await resolvePreflight(
      options.request.config,
      options.request,
    ).ensureGeneratedArtifactsMaterialized()
  ).graph;
  const allCheckers = generatedGraph.checkers;
  const managed = getManagedBuildTargets({
    allCheckers,
    generatedGraph,
    sourceConfigPath: options.sourceConfigPath,
  });
  const buildCapableDeclarationTargets =
    managed.declarationTargets.filter(isBuildCapable);
  const buildCapableOutputTargets =
    managed.outputTargets.filter(isBuildCapable);
  const checkerTargets = selectCheckerTargets({
    checker: options.request.checker,
    targets: buildCapableOutputTargets,
  });
  return {
    allCheckers,
    availableCheckers: uniqueSortedStrings(
      buildCapableOutputTargets.map(({ checker }) => checker.preset),
    ),
    checkerTargets,
    generatedGraph,
    kind: 'managed',
    matchingCheckers: managed.declarationTargets.map(({ checker }) => checker),
    resolutionKind: getResolutionKind({
      buildCapableDeclarationTargets,
      checkerTargets,
      declarationTargets: managed.declarationTargets,
    }),
    ...getSelectedCheckerField(options.request.checker),
    sourceConfigPath: options.sourceConfigPath,
  };
}

export async function resolveBuildTarget(
  options: ResolveBuildTargetOptions,
): Promise<ResolvedBuildTarget> {
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const targetConfigPath = resolveBuildConfigPath({
    configPath: options.configPath,
    cwd: options.cwd,
    project: options.project,
    rootDir: projectRootDir,
  });
  if (options.raw === true) {
    return resolveRawBuildTarget({
      checker: options.checker,
      projectRootDir,
      targetConfigPath,
    });
  }
  return resolveManagedBuildTarget({
    request: options,
    sourceConfigPath: targetConfigPath,
  });
}

export {
  collectManagedDeclarationBuildTargets,
  createRawBuildChecker,
  getBuildTargetDescriptorKey,
  getOutputDeclarationCopyContexts,
} from './target-descriptors';
export type {
  BuildTargetDescriptor,
  ManagedDeclarationBuildTarget,
} from './target-descriptors';
export { formatOutputBuildTargetResolutionProblem } from './target-problems';
