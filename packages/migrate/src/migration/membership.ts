import {
  collectReferencePathInfosFromConfigObject,
  type JsonObject,
  resolveReferencePath,
} from 'limina/internal/core/tsconfig/actions';
import { isPlainRecord } from 'limina/internal/utils/values';
import { MigrationInputError, type MigrationRecord } from './declarations';
import { relativeConfigPath } from './transform';
import type { MigrationTarget } from './types';

type MembershipEdge = Record<string, unknown> & { path: string };
interface MembershipOptions {
  rootDir: string;
  targets: ReadonlyMap<string, MigrationTarget>;
  objects: Map<string, JsonObject>;
  records: MigrationRecord[];
}
interface MembershipState {
  options: MembershipOptions;
  edges: Map<string, MembershipEdge[]>;
  solutions: Set<string>;
  sources: Set<string>;
  records: MigrationRecord[];
}
function isPathOnly(edge: MembershipEdge): boolean {
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

function dedupeMembership(
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

function membershipEdges(
  state: MembershipState,
  from: string,
): MembershipEdge[] {
  return state.edges.get(from) ?? [];
}

function hasMetadata(state: MembershipState, file: string): boolean {
  const metadata = state.options.objects.get(file)!.liminaOptions;
  return isPlainRecord(metadata) && Object.keys(metadata).length > 0;
}
function isExpandable(state: MembershipState, file: string): boolean {
  const target = state.options.targets.get(file)!;
  return target.isTypeScriptSolution && !target.isLiminaSolution;
}
function assertPlainWrapper(
  state: MembershipState,
  edge: MembershipEdge,
  target: string,
): void {
  if (!isPathOnly(edge))
    throw new MigrationInputError(
      `Cannot propagate reference attributes through named solution ${target}.`,
    );
  if (hasMetadata(state, target))
    throw new MigrationInputError(
      `Named solution ${target} has substantive Limina declarations.`,
    );
}
function expandMember(
  state: MembershipState,
  context: { from: string; wrapper: string; visiting: Set<string> },
  member: MembershipEdge,
): MembershipEdge[] {
  if (!isPathOnly(member))
    throw new MigrationInputError(
      `Cannot propagate reference attributes through named solution ${context.wrapper}.`,
    );
  return expand(
    state,
    { from: context.wrapper, visiting: context.visiting },
    member,
  ).map((child) => ({
    path: relativeConfigPath(
      context.from,
      resolveReferencePath(context.wrapper, child.path),
    ),
  }));
}
function expand(
  state: MembershipState,
  context: { from: string; visiting: Set<string> },
  edge: MembershipEdge,
): MembershipEdge[] {
  const target = resolveReferencePath(context.from, edge.path);
  if (!isExpandable(state, target)) return [{ ...edge }];
  assertPlainWrapper(state, edge, target);
  if (context.visiting.has(target)) {
    state.records.push({
      configPath: context.from,
      kind: 'removed-named-cycle-edge',
      original: edge,
      message: 'Cut a wrapper back edge while expanding its source members.',
      details: { target },
    });
    return [];
  }
  const visiting = new Set(context.visiting).add(target);
  return state.edges
    .get(target)!
    .flatMap((member) =>
      expandMember(
        state,
        { from: context.from, wrapper: target, visiting },
        member,
      ),
    );
}
function expandNamedWrappers(state: MembershipState): string[] {
  const retained = [...state.solutions]
    .filter((file) => state.options.targets.get(file)!.isLiminaSolution)
    .sort((left, right) => Number(left > right) - Number(left < right));
  for (const from of retained) {
    const edges = state.edges
      .get(from)!
      .flatMap((edge) =>
        expand(state, { from, visiting: new Set([from]) }, edge),
      );
    state.edges.set(from, dedupeMembership(from, edges));
  }
  return retained;
}

function isRetainAcyclicEdge(
  state: MembershipState,
  context: { from: string; stack: Set<string> },
  edge: MembershipEdge,
): boolean {
  const target = resolveReferencePath(context.from, edge.path);
  if (!context.stack.has(target)) return true;
  if (!isPathOnly(edge))
    throw new MigrationInputError(
      `Cannot remove attributed solution cycle edge: ${context.from} -> ${target}`,
    );
  state.records.push({
    configPath: context.from,
    kind: 'removed-cycle-edge',
    message: 'Removed a DFS back edge; source membership is compensated below.',
    original: edge,
    details: { target },
  });
  return false;
}

interface Traversal {
  visited: Set<string>;
  ordered: string[];
}
function visitChildren(
  state: MembershipState,
  traversal: Traversal,
  context: { from: string; stack: Set<string> },
): void {
  for (const edge of membershipEdges(state, context.from)) {
    const target = resolveReferencePath(context.from, edge.path);
    if (state.solutions.has(target))
      visit(state, traversal, { from: target, stack: context.stack });
  }
}
function visit(
  state: MembershipState,
  traversal: Traversal,
  context: { from: string; stack: Set<string> },
): void {
  if (traversal.visited.has(context.from)) return;
  traversal.visited.add(context.from);
  const stack = new Set(context.stack).add(context.from);
  state.edges.set(
    context.from,
    state.edges
      .get(context.from)!
      .filter((edge) =>
        isRetainAcyclicEdge(state, { from: context.from, stack }, edge),
      ),
  );
  visitChildren(state, traversal, { from: context.from, stack });
  traversal.ordered.push(context.from);
}
function compensate(
  state: MembershipState,
  from: string,
  baseline: ReadonlySet<string>,
): void {
  const current = reachableSources(state, from);
  const missingSources = [...baseline]
    .filter((source) => !current.has(source))
    .sort((left, right) => Number(left > right) - Number(left < right));
  for (const missing of missingSources)
    state.edges.get(from)!.push({ path: relativeConfigPath(from, missing) });
  if (
    JSON.stringify(
      [...reachableSources(state, from)].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    ) !==
    JSON.stringify(
      [...baseline].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    )
  )
    throw new Error(`Migration membership invariant failed for ${from}`);
}
function isApplyMembership(state: MembershipState, from: string): boolean {
  const object = state.options.objects.get(from)!;
  const references = state.edges.get(from)!;
  if (JSON.stringify(object.references) === JSON.stringify(references))
    return false;
  state.records.push({
    configPath: from,
    kind: 'membership-rewritten',
    message:
      'Expanded/pruned membership with the retained source reachability preserved.',
    original: object.references,
    details: {
      references,
      sources: [...reachableSources(state, from)].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    },
  });
  object.references = references;
  return true;
}
export function rewriteMembership(options: MembershipOptions): Set<string> {
  const state = createMembershipState(options);
  const baseline = new Map(
    [...state.solutions].map((from) => [from, reachableSources(state, from)]),
  );
  const retained = expandNamedWrappers(state);
  const traversal: Traversal = { visited: new Set(), ordered: [] };
  for (const from of retained)
    visit(state, traversal, { from, stack: new Set() });
  for (const from of traversal.ordered)
    compensate(state, from, baseline.get(from)!);
  // Publish only after every rewrite and reachability invariant has passed.
  const changed = new Set(
    [...state.solutions].filter((from) => isApplyMembership(state, from)),
  );
  options.records.push(...state.records);
  return changed;
}
