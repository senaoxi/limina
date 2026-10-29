import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { CandidateBuildPlan } from './analysis-admission';
import type { SupplementalAssessment } from './pending-supplemental-assessment';
import type { GovernedSourceUnit } from './types';

export interface CompilationReferenceIdentity {
  from: { sourceConfigPath: string; checkerName: string };
  to: { sourceConfigPath: string; checkerName: string };
  fromConfigPath: string;
  toConfigPath: string;
  kind: string;
}
interface CompilationProjection {
  supplements?: readonly SupplementalAssessment[];
  sources: readonly GovernedSourceUnit[];
  contexts: readonly NativeEvidenceContext[];
  references?: readonly CompilationReferenceIdentity[];
  consumers?: readonly { sourceConfigPath: string; checkerName: string }[];
}
/**
Runtime provenance shared by Core producers and the execution projection. Cache flags confer no authority.
*/
export const projections: WeakMap<CandidateBuildPlan, CompilationProjection> =
  new WeakMap();

export function bindCompilationProjection(
  candidate: CandidateBuildPlan,
  sources: readonly GovernedSourceUnit[],
): void {
  projections.set(candidate, { sources, contexts: [] });
}
export function bindCurrentCompilationContexts(
  candidate: CandidateBuildPlan | undefined,
  contexts: readonly NativeEvidenceContext[],
): void {
  if (candidate === undefined) return;
  const projection = projections.get(candidate);
  if (projection !== undefined)
    projection.contexts = contexts.filter(
      (context) => context.authority.phase === 'locked',
    );
}
export function bindExecutionCompilationProjection(
  from: CandidateBuildPlan,
  to: CandidateBuildPlan,
  input: Omit<CompilationProjection, 'contexts'>,
): void {
  const projection = projections.get(from);
  if (projection !== undefined)
    projections.set(to, { ...projection, ...input });
}
function hasConsumer(
  projection: CompilationProjection,
  source: GovernedSourceUnit,
): boolean {
  return (
    projection.consumers === undefined ||
    projection.consumers.some((consumer) =>
      [
        consumer.sourceConfigPath === source.configPath,
        consumer.checkerName === source.primaryCheckerName,
      ].every(Boolean),
    )
  );
}
export function projectionConsumers(
  candidate: CandidateBuildPlan,
  config: string,
): GovernedSourceUnit[] {
  const projection = projections.get(candidate);
  return projection === undefined
    ? []
    : projection.sources.filter(
        (source) =>
          source.configPath === config && hasConsumer(projection, source),
      );
}

export function bindSupplementalCompilationContexts(
  candidate: CandidateBuildPlan | undefined,
  supplements: readonly SupplementalAssessment[],
): void {
  const projection =
    candidate === undefined ? undefined : projections.get(candidate);
  if (projection !== undefined) projection.supplements = supplements;
}
