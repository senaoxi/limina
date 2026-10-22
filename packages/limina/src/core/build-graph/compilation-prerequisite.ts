import { isBuildCapablePreset } from '#checkers';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type {
  NativeCoverage,
  NativeFileIdentity,
} from '../../domain/analysis/native-coverage';
import type {
  NativeEvidenceSnapshot,
  NativeRequest,
} from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { qualifiedNativeEvidenceTarget } from '../typescript-semantic/native-fact-qualification';
import type { CandidateBuildPlan } from './analysis-admission';
import { projectionConsumers, projections } from './compilation-projection';
import type { GovernedSourceUnit } from './types';
export {
  bindCompilationProjection,
  bindCurrentCompilationContexts,
  bindExecutionCompilationProjection,
} from './compilation-projection';

export type CompilationRelation =
  | 'declaration-reference'
  | 'framework-schedule';
/**
Shared with the producer: a framework schedule consumes source, not a producer process.
*/
export function shouldUseDeclarationProvider(
  source: GovernedSourceUnit,
  file: string,
): boolean {
  return (
    isBuildCapablePreset(source.primaryCheckerName) &&
    ['.svelte', '.astro'].every((extension) => !file.endsWith(extension))
  );
}
export interface ProjectedCompilationPrerequisite {
  readonly snapshot: NativeEvidenceSnapshot;
  readonly obligation: NativeCompilationObligation;
  readonly context: NativeEvidenceContext;
  readonly requests: NativeEvidenceSnapshot['requests'];
  readonly coverage: NativeEvidenceSnapshot['coverage'];
  readonly requiredRelation: CompilationRelation;
  readonly projectionSource: GovernedSourceUnit | undefined;
  readonly targetIdentities: readonly NativeFileIdentity[];
  readonly consumption: 'referenced-project' | 'source-input';
}
interface ProjectionInput {
  snapshot: NativeEvidenceSnapshot;
  obligation: NativeCompilationObligation;
  candidate: CandidateBuildPlan;
}
function qualifiedRequests(
  input: ProjectionInput,
  context: NativeEvidenceContext,
  coverage: readonly NativeCoverage[],
): NativeRequest[] | undefined {
  const requests = input.snapshot.requests.filter((item) =>
    input.obligation.requestIds.includes(item.id),
  );
  const isComplete = [
    requests.length > 0,
    requests.length === input.obligation.requestIds.length,
  ].every(Boolean);
  if (!isComplete) return undefined;
  return requests.every((request) =>
    coverageForRequest(input.snapshot, request.id, coverage).some(
      (item) =>
        qualifiedNativeEvidenceTarget(
          {
            requestId: request.id,
            origin: request.origin,
            coverage: item,
            obligation: input.obligation,
          },
          context,
        ) !== null,
    ),
  )
    ? requests
    : undefined;
}
export function projectCompilationPrerequisite(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
  candidate: CandidateBuildPlan,
): ProjectedCompilationPrerequisite | undefined {
  const input = { snapshot, obligation, candidate };
  const context = projections
    .get(candidate)
    ?.contexts.find((item) => item.id === obligation.consumerContextId);
  return context === undefined
    ? undefined
    : projectQualifiedPrerequisite(input, context);
}
function projectQualifiedPrerequisite(
  input: ProjectionInput,
  context: NativeEvidenceContext,
): ProjectedCompilationPrerequisite | undefined {
  const coverage = targetCoverage(input.snapshot, input.obligation);
  const requests = qualifiedRequests(input, context, coverage);
  if (requests === undefined) return undefined;
  const source = projectionSource(input);
  if (isMissingProjection(source, input.candidate)) return undefined;
  const requiredRelation = selectRelation(source, coverage);
  return {
    snapshot: input.snapshot,
    obligation: input.obligation,
    context,
    requests,
    coverage,
    requiredRelation,
    projectionSource: source,
    targetIdentities: coverage.map((item) => item.target),
    consumption: relationConsumption(requiredRelation),
  };
}
function hasSamePhysicalTarget(
  left: NativeFileIdentity,
  right: NativeFileIdentity,
): boolean {
  if (left.physical.state !== 'verified' || right.physical.state !== 'verified')
    return false;
  return [
    left.physical.canonicalId === right.physical.canonicalId,
    left.physical.inputVersion === right.physical.inputVersion,
  ].every(Boolean);
}
function targetCoverage(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
): NativeCoverage[] {
  const targets = snapshot.resolutions
    .flatMap((item) =>
      obligation.requestIds.includes(item.requestId) ? [item.target] : [],
    )
    .filter((item) => item !== null);
  return snapshot.coverage.filter((item) =>
    targets.some((target) => hasSamePhysicalTarget(item.target, target)),
  );
}
function selectRelation(
  source: GovernedSourceUnit | undefined,
  coverage: readonly NativeCoverage[],
): CompilationRelation {
  return source === undefined || source.frameworkCapabilities.length === 0
    ? 'declaration-reference'
    : frameworkRelation(source, coverage);
}
function frameworkRelation(
  source: GovernedSourceUnit,
  coverage: readonly NativeCoverage[],
): CompilationRelation {
  return coverage.every((item) =>
    shouldUseDeclarationProvider(source, item.target.lexicalPath),
  )
    ? 'declaration-reference'
    : 'framework-schedule';
}
export function compilationRelationFor(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
  candidate: CandidateBuildPlan,
): CompilationRelation | undefined {
  return projectCompilationPrerequisite(snapshot, obligation, candidate)
    ?.requiredRelation;
}

function projectionSource(
  input: ProjectionInput,
): GovernedSourceUnit | undefined {
  return projectionConsumers(
    input.candidate,
    input.obligation.consumerConfigId,
  )[0];
}

function coverageForRequest(
  snapshot: NativeEvidenceSnapshot,
  requestId: string,
  coverage: readonly NativeCoverage[],
): NativeCoverage[] {
  const targets = snapshot.resolutions
    .filter((item) => item.requestId === requestId)
    .flatMap((item) => (item.target === null ? [] : [item.target]));
  return coverage.filter((item) =>
    targets.some((target) => hasSamePhysicalTarget(item.target, target)),
  );
}

function isMissingProjection(
  source: GovernedSourceUnit | undefined,
  candidate: CandidateBuildPlan,
): boolean {
  return source === undefined || !projections.has(candidate);
}
function relationConsumption(
  relation: CompilationRelation,
): ProjectedCompilationPrerequisite['consumption'] {
  return relation === 'framework-schedule'
    ? 'source-input'
    : 'referenced-project';
}
