import {
  collectReferencePathInfosFromConfigObject,
  isPlainRecord,
  type JsonObject,
  resolveReferencePath,
} from 'limina/internal/migration';
import { MigrationInputError, type MigrationRecord } from './declarations';
import type { MigrationTarget } from './types';

export type MembershipEdge = Record<string, unknown> & { path: string };
export interface MembershipOptions {
  rootDir: string;
  targets: ReadonlyMap<string, MigrationTarget>;
  objects: Map<string, JsonObject>;
  records: MigrationRecord[];
}
export interface MembershipState {
  options: MembershipOptions;
  edges: Map<string, MembershipEdge[]>;
  solutions: Set<string>;
  sources: Set<string>;
  records: MigrationRecord[];
}
export function isPathOnly(edge: MembershipEdge): boolean {
  return Object.keys(edge).every((key) => key === 'path');
}

function hasStringPath(item: unknown): item is MembershipEdge {
  return isPlainRecord(item) && typeof item.path === 'string';
}
function isEdge(item: unknown): item is MembershipEdge {
  return hasStringPath(item) && item.path.trim() !== '';
}

function isRetainedEdge(
  state: MembershipState,
  from: string,
  edge: MembershipEdge,
): boolean {
  const target = resolveReferencePath(from, edge.path);
  if (state.options.objects.has(target)) return true;
  state.records.push({
    configPath: from,
    kind: 'removed-membership',
    message: 'Target is outside the retained topology.',
    original: edge,
    details: { target },
  });
  return false;
}

function collectEdges(state: MembershipState, from: string): MembershipEdge[] {
  const original = state.options.targets.get(from)!.configObject;
  const read = collectReferencePathInfosFromConfigObject(
    state.options.rootDir,
    from,
    original,
  );
  if (read.problems.length > 0)
    state.records.push({
      configPath: from,
      kind: 'invalid-membership',
      message: read.problems.join('\n'),
      original: original.references,
    });
  const raw = Array.isArray(original.references) ? original.references : [];
  return raw.filter(isEdge).filter((edge) => isRetainedEdge(state, from, edge));
}

export function createMembershipState(
  options: MembershipOptions,
): MembershipState {
  const solutions = new Set(
    options.targets
      .values()
      .filter(
        (target) =>
          target.isTypeScriptSolution && options.objects.has(target.configPath),
      )
      .map((target) => target.configPath),
  );
  const sources = new Set(
    options.objects.keys().filter((file) => !solutions.has(file)),
  );
  const state: MembershipState = {
    options,
    solutions,
    sources,
    edges: new Map(),
    records: [],
  };
  for (const from of solutions)
    state.edges.set(from, collectEdges(state, from));
  return state;
}

function isSameDeclaration(
  left: MembershipEdge,
  right: MembershipEdge,
): boolean {
  const attributes = (edge: MembershipEdge): string =>
    JSON.stringify(
      Object.entries(edge)
        .filter(([key]) => key !== 'path')
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return attributes(left) === attributes(right);
}

export function dedupeMembership(
  from: string,
  edges: MembershipEdge[],
): MembershipEdge[] {
  const retained = new Map<string, MembershipEdge>();
  for (const edge of edges) addUniqueEdge(retained, from, edge);
  return retained.values().toArray();
}
function addUniqueEdge(
  retained: Map<string, MembershipEdge>,
  from: string,
  edge: MembershipEdge,
): void {
  const target = resolveReferencePath(from, edge.path);
  const previous = retained.get(target);
  if (!previous) retained.set(target, edge);
  else if (!isSameDeclaration(previous, edge))
    throw new MigrationInputError(
      `Conflicting membership attributes: ${from} -> ${target}`,
    );
}

function edgeSources(
  state: MembershipState,
  target: string,
  seen: Set<string>,
): string[] {
  return state.sources.has(target)
    ? [target]
    : [...reachableSources(state, target, seen)];
}
export function reachableSources(
  state: MembershipState,
  from: string,
  seen: Set<string> = new Set<string>(),
): Set<string> {
  if (seen.has(from)) return new Set();
  seen.add(from);
  return new Set(
    membershipEdges(state, from).flatMap((edge) =>
      edgeSources(state, resolveReferencePath(from, edge.path), seen),
    ),
  );
}

export function membershipEdges(
  state: MembershipState,
  from: string,
): MembershipEdge[] {
  return state.edges.get(from) ?? [];
}
