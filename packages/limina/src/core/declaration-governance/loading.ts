import type { DeclarationLoadingPlan } from '../../domain/analysis/declaration-governance';
import { declarationResponsibility } from '../../domain/analysis/declaration-governance';
import { deriveNativeCoverage } from '../../domain/analysis/native-coverage';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';

/** A policy ceiling; the checker host must still establish a request-causal
 * grant. Resolver filesystem access never uses this source-loading ceiling. */
export function declarationLoadingCeiling(
  plan: DeclarationLoadingPlan,
  roots: readonly string[],
): (file: string) => boolean {
  const rootNames = new Set(roots);
  const rootIdentities = new Set(
    roots
      .filter((file) => isDeclarationFile(file))
      .flatMap((file) => {
        const identity = observeNativeFileIdentity(
          file,
          plan.coverage.inputVersion,
        );
        return identity.physical.state === 'verified'
          ? [identity.physical.canonicalId]
          : [];
      }),
  );
  const decisions = new Map<string, boolean>();
  return (file) => {
    if (plan.purpose === 'type-provider') return true;
    if (!isDeclarationFile(file)) return rootNames.has(file);
    const prior = decisions.get(file);
    if (prior !== undefined) return prior;
    const identity = observeNativeFileIdentity(
      file,
      plan.coverage.inputVersion,
    );
    const responsibility = declarationResponsibility({
      sourceConfig: plan.sourceConfig,
      root:
        rootNames.has(file) ||
        (identity.physical.state === 'verified' &&
          rootIdentities.has(identity.physical.canonicalId)),
      coverage: deriveNativeCoverage(plan.coverage, identity),
    });
    const isAllowed =
      responsibility?.kind === 'consumer' || responsibility?.kind === 'local';
    decisions.set(file, isAllowed);
    return isAllowed;
  };
}
