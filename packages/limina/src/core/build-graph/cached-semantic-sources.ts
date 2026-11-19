import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import { hasBoundFrameworkExecutionReceipt } from '../analysis-cache/framework-execution-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { vueContextId } from '../analysis-cache/vue-identity';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { withVueDeclarationLoading } from '../vue-semantic/loading-identity';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData, StoredGraphData } from './analysis-cache-schema';
import { createGovernedSourceUnit } from './governed-sources';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { createSourceProject } from './source-projects';
import type { GovernedSourceUnit, SourceProject } from './types';

interface Binding {
  cache: NativeAnalysisCache;
  stored: StoredGraphData;
  config: ResolvedLiminaInputs;
  graph: CachedGraphData;
  workspace: ValidatedWorkspaceContext;
  projectConfigCache?: CheckerProjectConfigCache;
  frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>;
}

export function hasBoundFrozenSources(input: Binding): boolean {
  const units = input.graph.governedSources
    .values()
    .flatMap((sources) => sources.values())
    .toArray();
  if (units.length !== input.frozenProjectsByConfigPath.size) return false;
  const activatedRegions = new WorkspaceRegionPathIndex(input.workspace);
  return units.every((unit) =>
    hasBoundFrozenUnit(input, activatedRegions, unit),
  );
}

function hasBoundFrozenUnit(
  input: Binding,
  activatedRegions: WorkspaceRegionPathIndex,
  unit: GovernedSourceUnit,
): boolean {
  const frozen = input.frozenProjectsByConfigPath.get(unit.configPath);
  const checkerName = input.graph.ownershipPlan.typeConfigs.get(
    unit.configPath,
  )?.finalOwner;
  if (frozen === undefined || checkerName !== unit.primaryCheckerName)
    return false;
  const project = createSourceProject({
    config: input.config,
    checkerName,
    packageRootDir: frozen.project.packageRootDir,
    frozen,
  });
  const current = createGovernedSourceUnit({
    activatedRegions,
    frozen,
    project,
    config: input.config,
    projectConfigCache: input.projectConfigCache,
  });
  if (
    !hasSameSourceProjection(unit, current) ||
    !hasSameVueContext(input.graph, unit, project) ||
    !hasSameGeneratedRoots(input.graph, unit, current.declarationFileNames)
  )
    return false;
  unit.astroSemanticProject = current.astroSemanticProject;
  unit.svelteSemanticProject = current.svelteSemanticProject;
  const receipt = input.stored.governedSources
    .get(checkerName)
    ?.get(unit.configPath)?.frameworkExecutionInputs;
  return current.frameworkCapabilities.length === 0
    ? receipt === undefined
    : receipt !== undefined &&
        hasBoundFrameworkExecutionReceipt(unit, input.cache.epoch, receipt);
}

function hasSameSourceProjection(
  unit: GovernedSourceUnit,
  current: GovernedSourceUnit,
): boolean {
  return [
    unit.packageRootDir === current.packageRootDir,
    nativeFingerprint(unit.semanticAuthority) ===
      nativeFingerprint(current.semanticAuthority),
    nativeFingerprint(unit.frameworkCapabilities) ===
      nativeFingerprint(current.frameworkCapabilities),
    nativeFingerprint(unit.buildProjection) ===
      nativeFingerprint(current.buildProjection),
    hasSameStrings(unit.context.checkerPresets, current.context.checkerPresets),
    hasSameStrings(unit.context.extensions, current.context.extensions),
    hasSameStrings(unit.ownedFileNames, current.ownedFileNames),
    hasSameStrings(unit.declarationFileNames, current.declarationFileNames),
  ].every(Boolean);
}

function hasSameVueContext(
  graph: CachedGraphData,
  unit: GovernedSourceUnit,
  current: SourceProject,
): boolean {
  const expected = current.context.vueSemanticIdentity;
  const restored = unit.context.vueSemanticIdentity;
  if (expected === undefined || restored === undefined)
    return expected === restored;
  if (graph.sourceConfigCoverage === undefined) return false;
  return (
    vueContextId(restored) ===
    vueContextId(
      withVueDeclarationLoading(expected, {
        version: 1,
        sourceConfig: current.configPath,
        purpose: 'graph',
        coverage: graph.sourceConfigCoverage,
      }),
    )
  );
}

function hasSameGeneratedRoots(
  graph: CachedGraphData,
  unit: GovernedSourceUnit,
  roots: readonly string[],
): boolean {
  const declaration = graph.sourceToDts
    .get(unit.primaryCheckerName)
    ?.get(unit.configPath);
  if (unit.buildProjection.kind === 'framework-checker') {
    const checker = unit.primaryCheckerName;
    return [
      declaration === undefined,
      !graph.sourceToBuild.get(checker)?.has(unit.configPath),
      !graph.configToOutputBuild.get(checker)?.has(unit.configPath),
      unit.checkConfigPath === undefined,
      unit.checkReferences === undefined,
      unit.declarationReferences.size === 0,
    ].every(Boolean);
  }
  if (
    declaration === undefined ||
    !hasGeneratedRoots(graph, declaration, roots)
  )
    return false;
  const output = graph.configToOutputBuild
    .get(unit.primaryCheckerName)
    ?.get(unit.configPath);
  return (
    output?.kind !== 'project' || hasGeneratedRoots(graph, output.path, roots)
  );
}

function hasGeneratedRoots(
  graph: CachedGraphData,
  configPath: string,
  roots: readonly string[],
): boolean {
  const content = graph.generatedFiles.get(configPath);
  if (content === undefined) return false;
  const config: unknown = JSON.parse(content);
  return (
    isPlainRecord(config) &&
    Array.isArray(config.include) &&
    config.include.length === 0 &&
    Array.isArray(config.files) &&
    config.files.every((file): file is string => typeof file === 'string') &&
    hasSameStrings(
      config.files.map((file) =>
        normalizeAbsolutePath(path.resolve(path.dirname(configPath), file)),
      ),
      roots,
    )
  );
}

function hasSameStrings(left: readonly string[], right: readonly string[]) {
  return (
    nativeFingerprint([...left].sort(compareCodeUnits)) ===
    nativeFingerprint([...right].sort(compareCodeUnits))
  );
}
