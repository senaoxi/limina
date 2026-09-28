import { isPlainRecord, resolveReferencePath } from 'limina/internal/migration';
import { MigrationInputError } from './declarations';
import {
  dedupeMembership,
  type MembershipEdge,
  type MembershipState,
  pathOnly,
} from './membership-state';
import { relativeConfigPath } from './transform';

function hasMetadata(state: MembershipState, file: string): boolean {
  const metadata = state.options.objects.get(file)!.liminaOptions;
  return isPlainRecord(metadata) && Object.keys(metadata).length > 0;
}
function expandable(state: MembershipState, file: string): boolean {
  const target = state.options.targets.get(file)!;
  return target.isTypeScriptSolution && !target.isLiminaSolution;
}
function assertPlainWrapper(
  state: MembershipState,
  edge: MembershipEdge,
  target: string,
): void {
  if (!pathOnly(edge))
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
  if (!pathOnly(member))
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
  if (!expandable(state, target)) return [{ ...edge }];
  assertPlainWrapper(state, edge, target);
  if (context.visiting.has(target))
    throw new MigrationInputError(
      `Named-wrapper membership cycle requires manual conversion: ${target}`,
    );
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
export function expandNamedWrappers(state: MembershipState): string[] {
  const retained = [...state.solutions]
    .filter((file) => state.options.targets.get(file)!.isLiminaSolution)
    .sort();
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
