import type {
  CheckerDependencyFact,
  CheckerOwnershipPlan,
} from '../../core/build-graph/checker-ownership-types';
import type { NativeDependencyFact } from '../../core/typescript-semantic/dependency-fact';

// Independent collections have distinct provenance. Compare stable semantics
// here; restoration tests compare full DTOs, including the original identities.
export function nativeFactMeaning(fact: NativeDependencyFact): unknown {
  const { identity: _identity, ...resolution } = fact.resolution;
  const { nativeEvidence, ...rest } = fact;
  return {
    ...rest,
    resolution,
    nativeEvidence: nativeEvidenceMeaning(nativeEvidence),
  };
}

function nativeEvidenceMeaning(
  evidence: NativeDependencyFact['nativeEvidence'],
) {
  if (evidence === undefined) return null;
  return {
    inputs: evidence.origin.context.inputs,
    authority: evidence.origin.context.authority,
    coverage: evidence.coverage,
    obligation: obligationMeaning(evidence.obligation),
  };
}

function obligationMeaning(
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'],
) {
  if (obligation === null) return null;
  return {
    target: obligation.targetConfigId,
    existence: obligation.existence.state,
    structure: obligation.structure.state,
    artifact: obligation.artifact.state,
    rule:
      obligation.existence.state === 'unknown'
        ? null
        : obligation.existence.proof.ruleOrObservation,
  };
}

function ownershipFactMeaning(fact: CheckerDependencyFact) {
  const { nativeEvidence, frameworkCandidate, ...rest } = fact;
  return {
    ...rest,
    nativeEvidence: nativeEvidenceMeaning(nativeEvidence),
    frameworkCandidate:
      frameworkCandidate === undefined
        ? undefined
        : {
            ...frameworkCandidate,
            origin: {
              source: frameworkCandidate.origin.source,
              family: frameworkCandidate.origin.family,
            },
          },
  };
}

export function graphMeaning(graph: { ownershipPlan: unknown }): unknown {
  const plan = graph.ownershipPlan as CheckerOwnershipPlan;
  return {
    ...graph,
    ownershipPlan: {
      ...plan,
      declarationContexts: plan.declarationContexts?.map(
        ({ contextId: _contextId, requestIds: _requestIds, ...decision }) =>
          decision,
      ),
      dependencyFacts: plan.dependencyFacts.map(ownershipFactMeaning),
      ownershipSelectionFacts:
        plan.ownershipSelectionFacts?.map(ownershipFactMeaning),
    },
  };
}
