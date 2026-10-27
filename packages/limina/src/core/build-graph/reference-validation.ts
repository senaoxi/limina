import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import path from 'pathe';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { GeneratedTsconfigGraphResult } from './types';

export const pendingReferenceValidation =
  'Final generated project references have not been validated.';
export interface ReferenceValidation {
  state: 'admitted' | 'denied' | 'unavailable';
  diagnostics: string[];
}
export interface ReferenceCycle {
  members: string[];
  edges: { from: string; to: string }[];
}

export function collectReferenceCycles(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): ReferenceCycle[] {
  const nodes = [
    ...new Set([
      ...graph.keys(),
      ...graph.values().flatMap((value) => [...value]),
    ]),
  ].sort(compareCodeUnits);
  return collectStronglyConnectedComponents(
    nodes,
    (node) => graph.get(node) ?? [],
  )
    .filter(
      (members) =>
        members.length > 1 || graph.get(members[0]!)?.has(members[0]!),
    )
    .map((members) => {
      const membersSet = new Set(members);
      return {
        members,
        edges: members.flatMap((from) =>
          [...(graph.get(from) ?? [])]
            .filter((to) => membersSet.has(to))
            .sort(compareCodeUnits)
            .map((to) => ({ from, to })),
        ),
      };
    });
}

/** Read the serialized candidate, including solution, entry and output configs.
 * Scheduling edges are deliberately absent from this graph. */
function validateReferences(
  files: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, string>,
): ReferenceValidation {
  try {
    const graph = new Map<string, Set<string>>();
    for (const file of sources.keys()) {
      const text = files.get(file);
      if (text === undefined)
        throw new Error(`Missing generated config: ${file}`);
      const config = JSON.parse(text) as { references?: { path: string }[] };
      const references = new Set(
        (config.references ?? []).map((reference) => {
          if (typeof reference.path !== 'string')
            throw new Error(`Invalid reference in ${file}`);
          const target = normalizeAbsolutePath(
            path.resolve(path.dirname(file), reference.path),
          );
          if (!sources.has(target))
            throw new Error(
              `Unbound generated reference: ${file} -> ${target}`,
            );
          return target;
        }),
      );
      graph.set(file, references);
    }
    const diagnostics = collectReferenceCycles(graph).map((cycle) =>
      [
        'Generated project reference cycle:',
        ...cycle.members.map(
          (member) =>
            `  project: ${member} (source config: ${sources.get(member)})`,
        ),
        '  references in cycle:',
        ...cycle.edges.map((edge) => `  reference: ${edge.from} -> ${edge.to}`),
        '  reason: TypeScript project references must be acyclic.',
      ].join('\n'),
    );
    return {
      state: diagnostics.length > 0 ? 'denied' : 'admitted',
      diagnostics,
    };
  } catch (error) {
    return { state: 'unavailable', diagnostics: [String(error)] };
  }
}

function addBuildConfigs(
  sources: Map<string, string>,
  checkers: GeneratedTsconfigGraphResult['sourceToBuild'],
  generatedCheckers: ReadonlyMap<string, string>,
): void {
  // Non-build checkers retain discovery solution metadata without writing it.
  // Use the same checker-entry boundary as writeCheckerArtifacts.
  for (const [checker, entries] of checkers) {
    if (!generatedCheckers.has(checker)) continue;
    for (const [source, module] of entries) sources.set(module.path, source);
  }
}

export function validateStagedReferences(
  state: GeneratedGraphPreparationState,
): void {
  const sources = new Map<string, string>();
  for (const projects of state.projectsByChecker.values())
    for (const project of projects)
      sources.set(project.dtsConfigPath, project.configPath);
  addBuildConfigs(sources, state.sourceToBuildByChecker, state.checkerEntries);
  addBuildConfigs(
    sources,
    state.configToOutputBuildByChecker,
    state.checkerEntries,
  );
  for (const [checker, entry] of state.checkerEntries)
    sources.set(entry, `${checker} entry`);
  state.dependencyAnalysis.referenceValidation = validateReferences(
    state.writeContext.files,
    sources,
  );
}

export function validateRestoredReferences(
  graph: Pick<
    GeneratedTsconfigGraphResult,
    | 'dependencyAnalysis'
    | 'generatedFiles'
    | 'sourceToDts'
    | 'sourceToBuild'
    | 'configToOutputBuild'
    | 'checkerEntries'
  >,
): void {
  if (graph.dependencyAnalysis === undefined) return;
  const sources = new Map<string, string>();
  for (const entries of graph.sourceToDts.values())
    for (const [source, generated] of entries) sources.set(generated, source);
  addBuildConfigs(sources, graph.sourceToBuild, graph.checkerEntries);
  addBuildConfigs(sources, graph.configToOutputBuild, graph.checkerEntries);
  for (const [checker, entry] of graph.checkerEntries)
    sources.set(entry, `${checker} entry`);
  graph.dependencyAnalysis.referenceValidation = validateReferences(
    graph.generatedFiles,
    sources,
  );
}
