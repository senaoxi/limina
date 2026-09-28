import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type {
  CheckerEvidence,
  LockedSemanticAuthority,
  SemanticAuthority,
  SemanticAuthoritySource,
  SemanticFamily,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

const semanticFamilyByChecker = {
  astro: 'astro',
  'svelte-check': 'svelte',
  tsc: 'typescript',
  tsgo: 'typescript',
  'vue-tsc': 'vue',
} as const satisfies Record<CheckerName, SemanticFamily>;

const semanticSources = new Set<CheckerEvidence['source']>([
  'config',
  'dependency',
  'explicit',
  'root-file',
]);

export function createPendingSemanticAuthority(): SemanticAuthority {
  return { baseline: 'typescript', kind: 'pending' };
}

export function getCheckerSemanticFamily(checker: CheckerName): SemanticFamily {
  return semanticFamilyByChecker[checker];
}

function isSemanticAuthoritySource(
  source: CheckerEvidence['source'],
): source is SemanticAuthoritySource {
  return semanticSources.has(source);
}

function sameLockedAuthority(
  left: LockedSemanticAuthority,
  right: LockedSemanticAuthority,
): boolean {
  return left.family === right.family && left.source === right.source;
}

function createAuthorityConflict(options: {
  config: ResolvedLiminaConfig;
  current: LockedSemanticAuthority;
  evidence: CheckerEvidence;
  family: SemanticFamily;
  state: TypeConfigOwnershipState;
}): string {
  return [
    'Semantic authority conflict:',
    `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
    `  locked family: ${options.current.family}`,
    `  locked source: ${options.current.source}`,
    `  incompatible family: ${options.family}`,
    `  evidence: ${options.evidence.source} (${options.evidence.detail})`,
    '  reason: one managed tsconfig cannot be interpreted by multiple semantic checker families.',
  ].join('\n');
}

function createFrozenMutationProblem(options: {
  config: ResolvedLiminaConfig;
  current: LockedSemanticAuthority;
  evidence: CheckerEvidence;
  family: SemanticFamily;
  state: TypeConfigOwnershipState;
}): string {
  return [
    'Semantic authority changed after the ownership fact freeze:',
    `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
    `  frozen family: ${options.current.family}`,
    `  attempted family: ${options.family}`,
    `  evidence: ${options.evidence.source} (${options.evidence.detail})`,
    '  reason: build coloring, promotion, solution constraints, fallback, and final ownership cannot change module semantics.',
  ].join('\n');
}

function checkLockedAuthority(options: {
  config: ResolvedLiminaConfig;
  current: LockedSemanticAuthority;
  evidence: CheckerEvidence;
  family: SemanticFamily;
  state: TypeConfigOwnershipState;
}): string | null {
  return options.current.family === options.family
    ? null
    : createAuthorityConflict(options);
}

function lockEligibleSemanticAuthority(options: {
  config: ResolvedLiminaConfig;
  evidence: CheckerEvidence;
  family: SemanticFamily;
  state: TypeConfigOwnershipState;
}): string | null {
  const authority = options.state.semanticAuthority;
  if (authority.kind === 'locked') {
    return checkLockedAuthority({ ...options, current: authority });
  }
  const frozen = options.state.frozenSemanticAuthority;
  if (frozen !== undefined) {
    return createFrozenMutationProblem({
      ...options,
      current: frozen,
    });
  }
  options.state.semanticAuthority = {
    family: options.family,
    kind: 'locked',
    source: options.evidence.source as SemanticAuthoritySource,
  };
  return null;
}

export function lockSemanticAuthorityForEvidence(options: {
  config: ResolvedLiminaConfig;
  evidence: CheckerEvidence;
  state: TypeConfigOwnershipState;
}): string | null {
  if (!isSemanticAuthoritySource(options.evidence.source)) return null;
  const family = getCheckerSemanticFamily(options.evidence.checker);
  return lockEligibleSemanticAuthority({ ...options, family });
}

function lockPendingTypeScriptBaseline(
  state: TypeConfigOwnershipState,
): LockedSemanticAuthority {
  const authority: LockedSemanticAuthority = {
    family: 'typescript',
    kind: 'locked',
    source: 'root-file',
  };
  state.semanticAuthority = authority;
  return authority;
}

function getLockedSemanticAuthority(
  state: TypeConfigOwnershipState,
): LockedSemanticAuthority {
  return state.semanticAuthority.kind === 'locked'
    ? state.semanticAuthority
    : lockPendingTypeScriptBaseline(state);
}

function freezeSemanticAuthorityState(options: {
  config: ResolvedLiminaConfig;
  state: TypeConfigOwnershipState;
}): string | null {
  const authority = getLockedSemanticAuthority(options.state);
  const frozen = options.state.frozenSemanticAuthority;
  if (frozen !== undefined && !sameLockedAuthority(frozen, authority)) {
    return [
      'Semantic authority freeze mismatch:',
      `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
      `  frozen family: ${frozen.family}`,
      `  current family: ${authority.family}`,
    ].join('\n');
  }
  options.state.frozenSemanticAuthority = { ...authority };
  return null;
}

export function freezeSemanticAuthorities(options: {
  config: ResolvedLiminaConfig;
  states: Iterable<TypeConfigOwnershipState>;
}): string[] {
  const problems: string[] = [];
  for (const state of options.states) {
    const problem = freezeSemanticAuthorityState({ ...options, state });
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

function hasValidFrozenSemanticAuthority(
  state: TypeConfigOwnershipState,
): boolean {
  const frozen = state.frozenSemanticAuthority;
  if (frozen === undefined) return false;
  if (state.semanticAuthority.kind !== 'locked') return false;
  return sameLockedAuthority(frozen, state.semanticAuthority);
}

function getFrozenFamily(state: TypeConfigOwnershipState): string {
  return state.frozenSemanticAuthority?.family ?? '(missing)';
}

function getCurrentFamily(state: TypeConfigOwnershipState): string {
  return state.semanticAuthority.kind === 'locked'
    ? state.semanticAuthority.family
    : 'pending';
}

function createFrozenInvariantProblem(options: {
  config: ResolvedLiminaConfig;
  state: TypeConfigOwnershipState;
}): string {
  return [
    'Semantic authority freeze invariant failed:',
    `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
    `  frozen family: ${getFrozenFamily(options.state)}`,
    `  current family: ${getCurrentFamily(options.state)}`,
  ].join('\n');
}

export function validateFrozenSemanticAuthorities(options: {
  config: ResolvedLiminaConfig;
  states: Iterable<TypeConfigOwnershipState>;
}): string[] {
  const problems: string[] = [];
  for (const state of options.states) {
    if (hasValidFrozenSemanticAuthority(state)) continue;
    problems.push(createFrozenInvariantProblem({ ...options, state }));
  }
  return problems;
}
