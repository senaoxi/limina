import { collectReferencePathInfosFromConfigObject } from 'limina/internal/core/tsconfig/actions';
import { collectStronglyConnectedComponents } from 'limina/internal/utils/strongly-connected-components';
import { isPlainRecord } from 'limina/internal/utils/values';
import type { MigrationPlanningState } from './planning-state';
import type { MigrationWritePlanItem } from './transaction';

function solutionEdges(state: MigrationPlanningState): Map<string, string[]> {
  const targets = state.targets
    .values()
    .filter((target) => target.isTypeScriptSolution);
  return new Map(
    targets.map((target) => [
      target.configPath,
      collectReferencePathInfosFromConfigObject(
        state.config.rootDir,
        target.configPath,
        target.configObject,
      ).references.map((reference) => reference.resolvedPath),
    ]),
  );
}

function isReachesIsolation(
  state: MigrationPlanningState,
  edges: ReadonlyMap<string, string[]>,
  from: string,
): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (state.isolated.has(file)) return true;
    enqueueUnvisited(edges, seen, { file, pending });
  }
  return false;
}
function enqueueUnvisited(
  edges: ReadonlyMap<string, string[]>,
  seen: Set<string>,
  traversal: { file: string; pending: string[] },
): void {
  if (seen.has(traversal.file)) return;
  seen.add(traversal.file);
  traversal.pending.push(...(edges.get(traversal.file) ?? []));
}
function implicitIsolationDependents(state: MigrationPlanningState): string[] {
  return state.records
    .filter((record) => record.kind === 'removed-implicit-reference')
    .filter((record) => isIsolatedTarget(state, record.details))
    .map((record) => record.configPath);
}
function isIsolatedTarget(
  state: MigrationPlanningState,
  details: unknown,
): boolean {
  return (
    isPlainRecord(details) &&
    typeof details.target === 'string' &&
    state.isolated.has(details.target)
  );
}
function joinGroups(
  groups: MigrationWritePlanItem[][],
  files: ReadonlySet<string>,
): MigrationWritePlanItem[][] {
  const related = groups.filter((group) =>
    group.some((item) => files.has(item.configPath)),
  );
  const independent = groups.filter((group) => !related.includes(group));
  return related.length === 0 ? independent : [related.flat(), ...independent];
}

/**
Only edits of a solution cycle or a shared persisted isolation are coupled.
*/
export function createCommitGroups(
  state: MigrationPlanningState,
  patches: MigrationWritePlanItem[],
  membershipChanges: ReadonlySet<string>,
): MigrationWritePlanItem[][] {
  const edges = solutionEdges(state);
  const components = collectStronglyConnectedComponents(
    edges.keys().toArray(),
    (file) => edges.get(file)!.filter((target) => edges.has(target)),
  );
  let groups = patches.map((item) => [item]);
  for (const component of components)
    groups = joinGroups(
      groups,
      new Set(component.filter((file) => membershipChanges.has(file))),
    );
  return coupleIsolation(state, { edges, groups, patches });
}
function coupleIsolation(
  state: MigrationPlanningState,
  input: {
    edges: Map<string, string[]>;
    groups: MigrationWritePlanItem[][];
    patches: MigrationWritePlanItem[];
  },
): MigrationWritePlanItem[][] {
  if (
    input.patches.every((item) => item.configPath !== state.config.configPath)
  )
    return input.groups;
  const parents = input.edges
    .keys()
    .filter((file) => isReachesIsolation(state, input.edges, file));
  return joinGroups(
    input.groups,
    new Set([
      state.config.configPath,
      ...parents,
      ...implicitIsolationDependents(state),
    ]),
  );
}
