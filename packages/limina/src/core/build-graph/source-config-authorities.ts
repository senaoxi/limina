import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import type { AuthorityRecord } from '../analysis-cache/contracts';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { AutoScopeProject } from './auto-checker-types';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import {
  applyExplicitRequirements,
  commitFrameworkInference,
} from './checker-ownership-evidence';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { freezeSemanticAuthorities } from './checker-semantic-authority';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import type { FrameworkIntentHint } from './source-capabilities';
import type { AutoScope, ResolvedCheckerEntrySelection } from './types';

interface AuthorityInputs {
  restoreOnly?: boolean;
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  namedSelections: readonly ResolvedCheckerEntrySelection[];
  plan: CheckerOwnershipPlan;
  projects: ReadonlyMap<string, AutoScopeProject>;
  scopes: readonly AutoScope[];
}

type AuthorityInput =
  | ['solution', string]
  | ['explicit', string, CheckerName]
  | ['config', ...FrameworkIntentHint[]];

type AuthorityBinding = Pick<AuthorityRecord, 'closure' | 'projection'>;
const ownershipPolicyVersion = 1;

function projectAuthorityInputs(
  input: AuthorityInputs,
): Map<string, AuthorityInput[]> {
  const inputs = new Map(
    input.projects.keys().map((key) => [key, [] as AuthorityInput[]]),
  );
  for (const [solution, state] of input.plan.solutions)
    for (const leaf of state.sourceConfigPaths)
      inputs.get(leaf)?.push(['solution', solution]);
  for (const { checker, selection } of input.namedSelections)
    for (const entry of selection.effectiveEntryPaths) {
      const leaves = input.plan.solutions.get(entry)?.sourceConfigPaths ?? [
        entry,
      ];
      for (const leaf of leaves)
        inputs.get(leaf)?.push(['explicit', entry, checker.name]);
    }
  for (const scope of input.scopes)
    for (const evidence of scope.frameworkEvidence)
      if (evidence.intentHints.length > 0)
        inputs
          .get(evidence.configPath)
          ?.push(['config', ...evidence.intentHints]);
  return inputs;
}

function receipt(record: Omit<AuthorityRecord, 'fingerprint'>): string {
  return nativeFingerprint([
    record.policy,
    record.projection,
    record.closure,
    record.seed,
    record.ambiguousCheckers,
  ]);
}

function readAuthority(
  cache: NativeAnalysisCache,
  configPath: string,
  binding: AuthorityBinding,
): AuthorityRecord | undefined {
  const prior = cache.previous?.authorities[configPath];
  if (prior === undefined || prior.policy !== ownershipPolicyVersion)
    return undefined;
  const isCurrent =
    prior.projection === binding.projection &&
    prior.seed.configPath === configPath &&
    prior.closure.length === binding.closure.length &&
    prior.closure.every((file, index) => file === binding.closure[index]);
  if (
    !isCurrent ||
    receipt(prior) !== prior.fingerprint ||
    !cache.inputs.configCurrent(binding.closure)
  )
    return undefined;
  if (cache.authorities[configPath] !== prior)
    cache.increment('authorityRecoveries');
  cache.authorities[configPath] = prior;

  return prior;
}

function recoverAuthorities(input: AuthorityInputs) {
  const bindings = new Map<string, AuthorityBinding>();
  const unresolved = new Map(input.plan.typeConfigs);
  const ambiguities: FrameworkInferenceAmbiguity[] = [];
  const { cache } = input;
  if (cache === undefined) return { bindings, unresolved, ambiguities };
  const currentInputs = projectAuthorityInputs(input);
  for (const [key, project] of input.projects) {
    const closure = project.configClosure.map(({ filePath }) => filePath);
    if (
      !closure.includes(key) ||
      closure.some((file) => project.virtualFiles?.has(file))
    )
      continue;
    const binding = {
      closure,
      projection: nativeFingerprint([key, currentInputs.get(key)]),
    };
    bindings.set(key, binding);
    const prior = readAuthority(cache, key, binding);
    if (prior === undefined) continue;
    input.plan.typeConfigs.set(key, structuredClone(prior.seed));
    unresolved.delete(key);
    if (prior.ambiguousCheckers.length > 0)
      ambiguities.push({
        sourceConfigPath: key,
        checkers: prior.ambiguousCheckers,
      });
  }
  return { bindings, unresolved, ambiguities };
}

export function resolveSourceConfigAuthorities(input: AuthorityInputs): {
  complete: boolean;
  problems: string[];
  ambiguities: FrameworkInferenceAmbiguity[];
} {
  const { cache, config, plan } = input;
  const { bindings, unresolved, ambiguities } = recoverAuthorities(input);
  const retired = Object.keys(cache?.previous?.authorities ?? {}).filter(
    (configPath) => !input.projects.has(configPath),
  );
  if (cache?.previous !== undefined) {
    for (const configPath of [...unresolved.keys(), ...retired])
      cache.invalidateSourceConfig(configPath);
  }
  if (input.restoreOnly && unresolved.size + retired.length > 0)
    return { problems: [], ambiguities, complete: false };
  const working = { ...plan, typeConfigs: unresolved };
  const problems = input.namedSelections.flatMap(({ checker, selection }) =>
    applyExplicitRequirements({
      config,
      explicitOwnerByEntryPath: new Map(
        selection.effectiveEntryPaths.map((entry) => [entry, checker.name]),
      ),
      plan: working,
    }),
  );
  if (unresolved.size === 0) return { complete: true, problems, ambiguities };
  problems.push(
    ...applyConfigEvidence({ config, plan: working, scopes: input.scopes }),
  );
  const inference = commitFrameworkInference({ config, plan: working });
  ambiguities.push(...inference.ambiguities);
  problems.push(
    ...inference.problems,
    ...freezeSemanticAuthorities({
      config,
      states: unresolved
        .values()
        .filter((state) => state.semanticAuthorityUnavailable === undefined),
    }),
  );
  const warnings = new Map(
    inference.ambiguities.map((a) => [a.sourceConfigPath, a.checkers]),
  );
  for (const [key, seed] of unresolved) {
    cache?.increment('ownershipResolutions');
    if (
      !cache ||
      problems.length > 0 ||
      seed.frozenSemanticAuthority === undefined
    )
      continue;
    const binding = bindings.get(key);
    if (!binding) continue;
    const record: Omit<AuthorityRecord, 'fingerprint'> = {
      policy: ownershipPolicyVersion,
      ...binding,
      seed: structuredClone(seed),
      ambiguousCheckers: warnings.get(key) ?? [],
    };
    cache.authorities[key] = { ...record, fingerprint: receipt(record) };
  }
  return { complete: true, problems, ambiguities };
}
