import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import { vueContextId } from '../analysis-cache/vue-identity';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { withVueDeclarationLoading } from '../vue-semantic/loading-identity';
import type { CachedGraphData } from './analysis-cache-schema';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { createSourceProject } from './source-projects';
import type { GovernedSourceUnit, SourceProject } from './types';

interface Binding {
  config: ResolvedLiminaInputs;
  graph: CachedGraphData;
  frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>;
}

export function hasBoundFrozenSources(input: Binding): boolean {
  const units = input.graph.governedSources
    .values()
    .flatMap((sources) => sources.values())
    .toArray();
  if (units.length !== input.frozenProjectsByConfigPath.size) return false;
  return units.every((unit) => {
    const frozen = input.frozenProjectsByConfigPath.get(unit.configPath);
    if (frozen === undefined) return false;
    const current = createSourceProject({
      config: input.config,
      checkerName: unit.primaryCheckerName,
      packageRootDir: frozen.project.packageRootDir,
      frozen,
    });
    return (
      hasSameSourceProjection(unit, current) &&
      hasSameVueContext(input.graph, unit, current) &&
      hasSameGeneratedRoots(input.graph, unit, current.fileNames)
    );
  });
}

function hasSameSourceProjection(
  unit: GovernedSourceUnit,
  current: SourceProject,
): boolean {
  return (
    unit.packageRootDir === current.packageRootDir &&
    nativeFingerprint(unit.semanticAuthority) ===
      nativeFingerprint(current.semanticAuthority) &&
    hasSameStrings(
      unit.context.checkerPresets,
      current.context.checkerPresets,
    ) &&
    hasSameStrings(unit.context.extensions, current.context.extensions) &&
    hasSameStrings(unit.ownedFileNames, current.ownedFileNames) &&
    hasSameStrings(unit.declarationFileNames, current.fileNames)
  );
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
