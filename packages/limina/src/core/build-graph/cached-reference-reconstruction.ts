import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { projectNativeReferences } from '../../domain/analysis/native-reference-projection';
import type { StoredGraphData } from './analysis-cache-schema';
import { projectCompilationPrerequisite } from './compilation-prerequisite';
import { projectedProvider } from './compilation-reference';
import { hasBoundGeneratedReferences } from './generated-reference-binding';
import { readImplicitReferences } from './generated/config-readers';
import type { GovernedSourceUnit } from './types';

interface Reconstruction {
  graph: StoredGraphData;
  config: ResolvedLiminaInputs;
  sources: readonly GovernedSourceUnit[];
  vueReferences: ReadonlyMap<string, ReadonlySet<string>>;
}
function implicitTargets(
  input: Reconstruction,
  source: GovernedSourceUnit,
): string[] {
  const implicit = readImplicitReferences(input.config, source.configPath);
  if (implicit.problems.length > 0)
    throw new Error('Invalid implicit references.');
  return implicit.implicitRefs.map((reference) => {
    const target = input.graph.sourceToDts
      .get(source.primaryCheckerName)
      ?.get(reference.targetConfigPath);
    if (target === undefined)
      throw new Error('Missing implicit provider mapping.');
    return target;
  });
}
interface Relation {
  snapshot: NativeEvidenceSnapshot;
  obligation: NativeCompilationObligation;
}
function nativeProvider(
  input: Reconstruction,
  source: GovernedSourceUnit,
  relation: Relation,
): string {
  const prerequisite = projectCompilationPrerequisite(
    relation.snapshot,
    relation.obligation,
    input.graph.dependencyAnalysis.candidate!,
  );
  requirePrerequisite(prerequisite);
  const provider = projectedProvider(source, {
    sources: input.sources,
    target: relation.obligation.targetConfigId!,
    files: prerequisite!.targetIdentities.map((item) => item.lexicalPath),
  });
  if (provider === undefined || !('dtsConfigPath' in provider.buildProjection))
    throw new Error('Unmapped declaration provider.');
  return provider.buildProjection.dtsConfigPath;
}
function requiredRelations(
  snapshot: NativeEvidenceSnapshot,
  source: GovernedSourceUnit,
): Relation[] {
  return projectNativeReferences(snapshot)
    .relations.filter(
      ({ obligation, summary }) =>
        summary === 'required' &&
        obligation.consumerConfigId === source.configPath,
    )
    .filter(({ obligation }) =>
      snapshot.contexts.some(
        (context) =>
          context.id === obligation.consumerContextId &&
          context.authority.phase === 'locked',
      ),
    )
    .map(({ obligation }) => ({ snapshot, obligation }));
}
function hasBoundLeaf(
  input: Reconstruction,
  source: GovernedSourceUnit,
): boolean {
  if (!('dtsConfigPath' in source.buildProjection)) return true;
  if (source.semanticAuthority.family === 'vue')
    return hasVueReferences(input, source);
  const native = nativeEvidence(input.graph).flatMap(({ snapshot }) =>
    requiredRelations(snapshot, source),
  );
  const expected = new Set([
    ...implicitTargets(input, source),
    ...native.map((relation) => nativeProvider(input, source, relation)),
  ]);
  return hasSameReferences(source, expected);
}
function hasVueReferences(
  input: Reconstruction,
  source: GovernedSourceUnit,
): boolean {
  const expected = input.vueReferences.get(source.configPath);
  return expected !== undefined && hasSameReferences(source, expected);
}
function hasSameReferences(
  source: GovernedSourceUnit,
  expected: ReadonlySet<string>,
): boolean {
  return (
    expected.size === source.declarationReferences.size &&
    expected.isSubsetOf(source.declarationReferences)
  );
}
/**
Reconstruct cached leaf references from current implicitRefs and qualified semantic facts, never from cached admission.
*/
export function hasBoundCachedReferences(
  graph: StoredGraphData,
  config: ResolvedLiminaInputs,
  vueReferences: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const sources = graph.governedSources
    .values()
    .flatMap((units) => units.values())
    .toArray();
  try {
    return (
      sources.every((source) =>
        hasBoundLeaf({ graph, config, sources, vueReferences }, source),
      ) && hasBoundGeneratedReferences(graph, config)
    );
  } catch {
    return false;
  }
}

function requirePrerequisite(value: unknown): void {
  if (value === undefined) throw new Error('Unbound compilation prerequisite.');
}
function nativeEvidence(graph: StoredGraphData) {
  return graph.dependencyAnalysis.nativeEvidence ?? [];
}
