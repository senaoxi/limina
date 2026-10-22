/**
Proofs describe an observation/rule in a particular context, not an owner hit.
*/
export interface CompilationProof {
  readonly kind: 'compiler-observation' | 'audited-rule';
  readonly evidenceId: string;
  readonly contextId: string;
  readonly ruleOrObservation: string;
}

export type ObligationExistence =
  | { readonly state: 'present' | 'absent'; readonly proof: CompilationProof }
  | { readonly state: 'unknown'; readonly gapIds: readonly string[] };

export type ReferenceStructure =
  | {
      readonly state: 'satisfied' | 'unsatisfied';
      readonly evidenceId: string;
      readonly contextId: string;
      readonly rawReferenceFingerprint: string;
      readonly mapping: {
        readonly consumerConfigId: string;
        readonly targetConfigId: string;
        readonly redirectEvidenceIds: readonly string[];
      };
    }
  | { readonly state: 'unknown' | 'not-applicable'; readonly reason: string };

export type DeclarationAvailability =
  | {
      readonly state: 'available';
      readonly evidenceId: string;
      readonly producerInputFingerprint: string;
      readonly outputFingerprint: string;
      readonly validatedMappingId: string;
    }
  | { readonly state: 'missing' | 'stale'; readonly evidenceId: string }
  | { readonly state: 'unknown' | 'not-applicable'; readonly reason: string };

export interface NativeCompilationObligation {
  readonly id: string;
  readonly requestIds: readonly string[];
  readonly consumerContextId: string;
  readonly consumerConfigId: string;
  readonly rawReferenceFingerprint: string;
  readonly targetConfigId: string | null;
  readonly existence: ObligationExistence;
  readonly structure: ReferenceStructure;
  readonly artifact: DeclarationAvailability;
}

export type CompilationObligationSummary =
  | 'required'
  | 'already-satisfied'
  | 'not-required'
  | 'unknown';

function summarizeStructure(
  structure: ReferenceStructure,
): CompilationObligationSummary {
  if (structure.state === 'satisfied') return 'already-satisfied';
  return structure.state === 'unsatisfied' ? 'required' : 'unknown';
}

/**
Artifact readiness is deliberately not an input to this summary.
*/
export function summarizeCompilationObligation(
  obligation: NativeCompilationObligation,
): CompilationObligationSummary {
  return hasValidExistenceContext(obligation)
    ? summarizeProvenObligation(obligation)
    : 'unknown';
}

function hasValidExistenceContext(
  obligation: NativeCompilationObligation,
): boolean {
  if (obligation.existence.state === 'unknown') return false;
  const proof = obligation.existence.proof;
  return (
    proof.contextId === obligation.consumerContextId &&
    hasRequestProofBinding(obligation, proof)
  );
}
function hasRequestProofBinding(
  obligation: NativeCompilationObligation,
  proof: CompilationProof,
): boolean {
  return (
    proof.kind === 'compiler-observation' ||
    obligation.requestIds.includes(proof.evidenceId)
  );
}

function summarizeProvenObligation(
  obligation: NativeCompilationObligation,
): CompilationObligationSummary {
  if (obligation.existence.state === 'absent') return 'not-required';
  return hasValidStructureContext(obligation)
    ? summarizeStructure(obligation.structure)
    : 'unknown';
}

function hasValidStructureContext(
  obligation: NativeCompilationObligation,
): boolean {
  const structure = obligation.structure;
  if (!('contextId' in structure)) return false;
  const actual = [
    structure.contextId,
    structure.rawReferenceFingerprint,
    structure.mapping.consumerConfigId,
    structure.mapping.targetConfigId,
  ];
  const expected = [
    obligation.consumerContextId,
    obligation.rawReferenceFingerprint,
    obligation.consumerConfigId,
    obligation.targetConfigId,
  ];
  return actual.every((value, index) => value === expected[index]);
}
