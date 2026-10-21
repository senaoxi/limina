import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { AnalysisOutcome } from './analysis-outcome';
import type { DependencyAnalysisResult } from './types';

export interface CandidateBuildPlan {
  readonly configPaths: readonly string[];
  readonly schedules: readonly { readonly from: string; readonly to: string }[];
  readonly references: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}
type Prerequisites = Pick<
  AnalysisOutcome,
  'core' | 'governance' | 'graphTransaction'
>;
type Admission = AnalysisOutcome['buildAdmission'];

export function candidateAdmission(
  analysis: DependencyAnalysisResult,
  outcome: Prerequisites,
): Admission {
  if (outcome.governance.state === 'violations')
    return admission('denied', outcome.governance.diagnostics);
  if (analysis.candidate === undefined)
    return admission('unavailable', [
      'No concrete candidate build plan was established.',
    ]);
  return assessCandidate(analysis, analysis.candidate, outcome);
}

function admission(
  state: Admission['state'],
  reasons: readonly string[],
): Admission {
  return {
    scope: 'generated-graph-materialization',
    state,
    reasons: [...new Set(reasons)],
  };
}

function assessCandidate(
  analysis: DependencyAnalysisResult,
  candidate: CandidateBuildPlan,
  outcome: Prerequisites,
): Admission {
  const configs = new Set(candidate.configPaths);
  const unknown = workGaps(configs, outcome);
  const denied: string[] = [];
  const evidenceEntries = nativeEntries(analysis);
  for (const evidence of evidenceEntries)
    assessRelations(evidence.snapshot, candidate, { unknown, denied });
  return denied.length > 0
    ? admission('denied', denied)
    : uncertainAdmission(unknown);
}

function workGaps(
  configs: ReadonlySet<string>,
  outcome: Prerequisites,
): string[] {
  const gaps = [...configs].flatMap((config) =>
    configWorkGaps(config, outcome),
  );
  if (outcome.governance.state === 'unavailable')
    gaps.push('Applicable governance evidence is unavailable.');
  gaps.push(...outcome.graphTransaction.failures);
  return gaps;
}

function configWorkGaps(config: string, outcome: Prerequisites): string[] {
  const locked = outcome.core.entries.find(
    (entry) => entry.configPath === config && entry.phase === 'locked',
  );
  return locked === undefined
    ? [`${config}: locked collection was not scheduled.`]
    : outcome.core.entries
        .filter((entry) => entry.configPath === config && !isCompleted(entry))
        .map(
          (entry) =>
            `${config}: ${entry.reason ?? entry.execution} (${entry.phase})`,
        );
}

function isCompleted(entry: Prerequisites['core']['entries'][number]): boolean {
  return entry.eligibility === 'eligible' && entry.execution === 'completed';
}

function assessRelations(
  snapshot: NativeEvidenceSnapshot,
  candidate: CandidateBuildPlan,
  result: { unknown: string[]; denied: string[] },
): void {
  const configs = new Set(candidate.configPaths);
  const applicable = snapshot.obligations.filter((obligation) =>
    isCandidateObligation(snapshot, obligation, configs),
  );
  for (const obligation of applicable)
    assessObligation({ snapshot, candidate, result }, obligation);
}
function assessObligation(
  input: {
    snapshot: NativeEvidenceSnapshot;
    candidate: CandidateBuildPlan;
    result: { unknown: string[]; denied: string[] };
  },
  obligation: NativeCompilationObligation,
): void {
  const { snapshot, candidate, result } = input;
  const state = summarizeCompilationObligation(obligation);
  if (state === 'required')
    assessRequired(candidate, obligation, result.denied);
  else if (state === 'unknown')
    assessUnknown({ snapshot, candidate }, obligation, result.unknown);
}
function assessRequired(
  candidate: CandidateBuildPlan,
  obligation: NativeCompilationObligation,
  denied: string[],
): void {
  if (!hasReference(candidate, obligation))
    denied.push(`Unsatisfied compilation obligation: ${obligation.id}`);
}
function assessUnknown(
  input: { snapshot: NativeEvidenceSnapshot; candidate: CandidateBuildPlan },
  obligation: NativeCompilationObligation,
  unknown: string[],
): void {
  const { snapshot, candidate } = input;
  if (hasReference(candidate, obligation)) return;
  if (hasCandidateImpact(snapshot, obligation))
    unknown.push(`Unproved necessary compilation relation: ${obligation.id}`);
}

function isCandidateObligation(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
  configs: ReadonlySet<string>,
): boolean {
  const context = snapshot.contexts.find(
    (item) => item.id === obligation.consumerContextId,
  );
  return (
    context?.authority.phase === 'locked' &&
    configs.has(obligation.consumerConfigId)
  );
}

function hasReference(
  candidate: CandidateBuildPlan,
  obligation: NativeCompilationObligation,
): boolean {
  return (
    obligation.targetConfigId !== null &&
    candidate.configPaths.includes(obligation.targetConfigId) &&
    [...candidate.references, ...candidate.schedules].some(
      (pair) =>
        pair.from === obligation.consumerConfigId &&
        pair.to === obligation.targetConfigId,
    )
  );
}

function hasCandidateImpact(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
): boolean {
  return (
    obligation.targetConfigId !== null ||
    hasUnknownTargetImpact(snapshot, obligation)
  );
}
function hasUnknownTargetImpact(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
): boolean {
  const resolutions = snapshot.resolutions.filter((resolution) =>
    obligation.requestIds.includes(resolution.requestId),
  );
  // The consumer has already been matched to the candidate. An unavailable
  // path selection cannot prove that this required source input is irrelevant.
  return (
    resolutions.some(
      (resolution) => resolution.pathSelection?.state === 'unavailable',
    ) || hasCoveredCandidate(snapshot, resolutions)
  );
}
function hasCoveredCandidate(
  snapshot: NativeEvidenceSnapshot,
  resolutions: NativeEvidenceSnapshot['resolutions'],
): boolean {
  return resolutions.some((resolution) =>
    snapshot.coverage.some(
      (coverage) =>
        coverage.target.lexicalPath === resolution.target?.lexicalPath &&
        coverage.members.length > 0,
    ),
  );
}

function uncertainAdmission(reasons: string[]): Admission {
  return admission(reasons.length > 0 ? 'unavailable' : 'admitted', reasons);
}

function nativeEntries(analysis: DependencyAnalysisResult) {
  return analysis.nativeEvidence ?? [];
}

export class CandidateAdmissionUnavailable extends Error {
  constructor(reasons: readonly string[]) {
    super(reasons.join('\n\n'));
    this.name = 'CandidateAdmissionUnavailable';
  }
}
