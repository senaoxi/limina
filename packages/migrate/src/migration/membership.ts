import { resolveReferencePath } from 'limina/internal/migration';
import { MigrationInputError } from './declarations';
import { expandNamedWrappers } from './membership-expansion';
import {
  createMembershipState,
  isPathOnly,
  type MembershipEdge,
  membershipEdges,
  type MembershipOptions,
  type MembershipState,
  reachableSources,
} from './membership-state';
import { relativeConfigPath } from './transform';

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
  const retained = expandNamedWrappers(state);
  const baseline = new Map(
    retained.map((from) => [from, reachableSources(state, from)]),
  );
  const traversal: Traversal = { visited: new Set(), ordered: [] };
  for (const from of retained)
    visit(state, traversal, { from, stack: new Set() });
  for (const from of traversal.ordered)
    compensate(state, from, baseline.get(from)!);
  // Publish only after every rewrite and reachability invariant has passed.
  const changed = new Set(
    retained.filter((from) => isApplyMembership(state, from)),
  );
  options.records.push(...state.records);
  return changed;
}
