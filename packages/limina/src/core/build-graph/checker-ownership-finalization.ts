import type { ResolvedLiminaInputs } from '#config/runner';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { assertOwnershipPhase } from './checker-ownership-evidence';

export function validateOwnershipConstraints(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  phase: string;
}): void {
  const problems = options.discovery.plan.typeConfigs
    .values()
    .flatMap((state) =>
      state.authoritativeOwner !== undefined &&
      state.localOwner.kind === 'resolved' &&
      state.authoritativeOwner !== state.localOwner.checker
        ? [
            `Checker ownership conflict: ${state.configPath}: ${state.authoritativeOwner} != ${state.localOwner.checker}`,
          ]
        : [],
    )
    .toArray();
  assertOwnershipPhase({
    config: options.config,
    fallback: `Checker ownership conflict after ${options.phase}.`,
    problems,
  });
}

export function finalizeOwnership(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
}): void {
  const { plan, autoChecker, activeEntryPaths } = options.discovery;
  for (const state of plan.typeConfigs.values()) {
    state.finalOwner =
      state.localOwner.kind === 'resolved'
        ? state.localOwner.checker
        : autoChecker;
  }
  validateOwnershipConstraints({ ...options, phase: 'source finalization' });
  for (const entry of activeEntryPaths) {
    const sources =
      plan.solutions.get(entry)?.sourceConfigPaths ??
      (plan.typeConfigs.has(entry) ? [entry] : undefined);
    if (sources === undefined)
      throw new Error(`Missing source entry: ${entry}`);
    plan.sourceConfigPathsByEntry.set(entry, [...sources]);
  }
}
