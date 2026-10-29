import { isBuildCapablePreset } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import path from 'pathe';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { GeneratedTsconfigGraphResult, GovernedSourceUnit } from './types';

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

class ReferenceConflict extends Error {}

function captureValidation(
  validate: () => ReferenceValidation,
): ReferenceValidation {
  try {
    return validate();
  } catch (error) {
    return {
      state: error instanceof ReferenceConflict ? 'denied' : 'unavailable',
      diagnostics: [String(error)],
    };
  }
}

interface ReferenceProject {
  kind: 'declaration' | 'solution' | 'output' | 'root';
  checkerName: string;
  sourceConfig: string;
}

function formatReferenceCycle(
  cycle: ReferenceCycle,
  sources: ReadonlyMap<string, ReferenceProject>,
): string {
  const checkers = new Set(
    cycle.members.map((member) => sources.get(member)!.checkerName),
  );
  return [
    'Generated project reference cycle:',
    `  config: ${cycle.members[0]}`,
    ...(checkers.size === 1 ? [`  checker: ${[...checkers][0]}`] : []),
    ...cycle.members.map(
      (member) =>
        `  project: ${member} (source config: ${sources.get(member)!.sourceConfig})`,
    ),
    '  references in cycle:',
    ...cycle.edges.map((edge) => `  reference: ${edge.from} -> ${edge.to}`),
    '  reason: TypeScript project references must be acyclic.',
  ].join('\n');
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
  sources: ReadonlyMap<string, ReferenceProject>,
  required: ReadonlyMap<string, ReadonlySet<string>>,
  entries: ReadonlyMap<string, string>,
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
      formatReferenceCycle(cycle, sources),
    );
    for (const [from, targets] of graph) {
      for (const to of targets) {
        if (sources.get(from)!.checkerName !== sources.get(to)!.checkerName)
          diagnostics.push(
            `Cross-checker generated reference: ${from} -> ${to}`,
          );
      }
    }
    for (const [checker, targets] of required) {
      const entry = entries.get(checker);
      const reachable = new Set<string>();
      const pending = entry === undefined ? [] : [entry];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (reachable.has(current)) continue;
        reachable.add(current);
        pending.push(...(graph.get(current) ?? []));
      }
      for (const target of targets)
        if (!reachable.has(target))
          diagnostics.push(
            `Incomplete checker build root: ${checker}: missing ${target}`,
          );
    }
    return {
      state: diagnostics.length > 0 ? 'denied' : 'admitted',
      diagnostics,
    };
  } catch (error) {
    return { state: 'unavailable', diagnostics: [String(error)] };
  }
}

function addBuildConfigs(
  sources: Map<string, ReferenceProject>,
  checkers: GeneratedTsconfigGraphResult['sourceToBuild'],
  generatedCheckers: ReadonlyMap<string, string>,
  purpose: 'build' | 'output',
): void {
  // Non-build checkers retain discovery solution metadata without writing it.
  // Use the same checker-entry boundary as writeCheckerArtifacts.
  for (const [checker, entries] of checkers) {
    if (!generatedCheckers.has(checker)) continue;
    for (const [source, module] of entries)
      addIdentity(sources, module.path, {
        kind:
          purpose === 'output'
            ? 'output'
            : module.kind === 'project'
              ? 'declaration'
              : 'solution',
        checkerName: checker,
        sourceConfig: source,
      });
  }
}

function addIdentity(
  sources: Map<string, ReferenceProject>,
  path: string,
  identity: ReferenceProject,
): void {
  const previous = sources.get(path);
  if (
    previous &&
    (previous.checkerName !== identity.checkerName ||
      previous.sourceConfig !== identity.sourceConfig ||
      previous.kind !== identity.kind)
  )
    throw new ReferenceConflict(
      `Conflicting generated config identity: ${path}`,
    );
  sources.set(path, identity);
}

function requiredTargets(
  plan: CheckerOwnershipPlan,
  units: Iterable<
    Iterable<{
      configPath: string;
      primaryCheckerName: string;
      buildProjection: GovernedSourceUnit['buildProjection'];
    }>
  >,
): Map<string, Set<string>> {
  const sources = new Map<string, { checker: string; path?: string }>();
  for (const group of units)
    for (const unit of group) {
      if (sources.has(unit.configPath))
        throw new ReferenceConflict(
          `Duplicate governed source: ${unit.configPath}`,
        );
      const projection = unit.buildProjection;
      sources.set(unit.configPath, {
        checker: unit.primaryCheckerName,
        path:
          'buildConfigPath' in projection
            ? projection.buildConfigPath
            : 'dtsConfigPath' in projection
              ? projection.dtsConfigPath
              : undefined,
      });
    }
  const required = new Map<string, Set<string>>();
  for (const state of plan.typeConfigs.values()) {
    const unit = sources.get(state.configPath);
    if (!unit || unit.checker !== state.finalOwner)
      throw new Error(
        `Missing or inconsistent source ownership: ${state.configPath}`,
      );
    if (!isBuildCapablePreset(state.finalOwner)) continue;
    if (!unit.path)
      throw new Error(`Missing source build projection: ${state.configPath}`);
    const targets = required.get(unit.checker) ?? new Set<string>();
    targets.add(unit.path);
    required.set(unit.checker, targets);
  }
  if (sources.size !== plan.typeConfigs.size)
    throw new ReferenceConflict('Unowned governed source.');
  return required;
}

export function validateStagedReferences(
  state: GeneratedGraphPreparationState,
): void {
  state.dependencyAnalysis.referenceValidation = captureValidation(() =>
    validateStagedGraph(state),
  );
}

function validateStagedGraph(
  state: GeneratedGraphPreparationState,
): ReferenceValidation {
  const sources = new Map<string, ReferenceProject>();
  for (const [checkerName, projects] of state.projectsByChecker)
    for (const project of projects)
      addIdentity(sources, project.dtsConfigPath, {
        kind: 'declaration',
        checkerName,
        sourceConfig: project.configPath,
      });
  addBuildConfigs(
    sources,
    state.sourceToBuildByChecker,
    state.checkerEntries,
    'build',
  );
  addBuildConfigs(
    sources,
    state.configToOutputBuildByChecker,
    state.checkerEntries,
    'output',
  );
  for (const [checker, entry] of state.checkerEntries)
    addIdentity(sources, entry, {
      kind: 'root',
      checkerName: checker,
      sourceConfig: `${checker} entry`,
    });
  return validateReferences(
    state.writeContext.files,
    sources,
    requiredTargets(
      state.checkerOwnershipPlan,
      state.governedSourcesByChecker.values(),
    ),
    state.checkerEntries,
  );
}

type RestoredGraph = Pick<
  GeneratedTsconfigGraphResult,
  | 'dependencyAnalysis'
  | 'generatedFiles'
  | 'sourceToDts'
  | 'sourceToBuild'
  | 'configToOutputBuild'
  | 'checkerEntries'
  | 'ownershipPlan'
  | 'governedSources'
>;

export function validateRestoredReferences(graph: RestoredGraph): void {
  if (graph.dependencyAnalysis === undefined) return;
  graph.dependencyAnalysis.referenceValidation = captureValidation(() =>
    validateRestoredGraph(graph),
  );
}

function validateRestoredGraph(graph: RestoredGraph): ReferenceValidation {
  const sources = new Map<string, ReferenceProject>();
  for (const [checkerName, entries] of graph.sourceToDts)
    for (const [source, generated] of entries)
      addIdentity(sources, generated, {
        kind: 'declaration',
        checkerName,
        sourceConfig: source,
      });
  addBuildConfigs(sources, graph.sourceToBuild, graph.checkerEntries, 'build');
  addBuildConfigs(
    sources,
    graph.configToOutputBuild,
    graph.checkerEntries,
    'output',
  );
  for (const [checker, entry] of graph.checkerEntries)
    addIdentity(sources, entry, {
      kind: 'root',
      checkerName: checker,
      sourceConfig: `${checker} entry`,
    });
  return validateReferences(
    graph.generatedFiles,
    sources,
    requiredTargets(
      graph.ownershipPlan,
      graph.governedSources.values().map((units) => units.values()),
    ),
    graph.checkerEntries,
  );
}
