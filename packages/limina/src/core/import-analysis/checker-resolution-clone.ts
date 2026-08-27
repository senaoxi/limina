import type { FrameworkSemanticFailure } from '../framework-semantic/contracts';
import { cloneTypeScriptResolution } from './resolver-caches';
import type { CanonicalImportResolutionEvidence } from './types';

function cloneFailure(
  failure: FrameworkSemanticFailure | undefined,
): FrameworkSemanticFailure | undefined {
  return failure === undefined ? undefined : { ...failure };
}

export function cloneCheckerResolutionEvidence(
  evidence: CanonicalImportResolutionEvidence,
): CanonicalImportResolutionEvidence {
  return {
    eligibility: { ...evidence.eligibility },
    oxcResolvedFilePath: null,
    runtimeEvidence: {
      ...evidence.runtimeEvidence,
      runtime: { ...evidence.runtimeEvidence.runtime },
    },
    semanticEvidence:
      evidence.semanticEvidence === undefined
        ? undefined
        : {
            ...evidence.semanticEvidence,
            sourceRecord: {
              ...evidence.semanticEvidence.sourceRecord,
              locator: { ...evidence.semanticEvidence.sourceRecord.locator },
            },
            target:
              evidence.semanticEvidence.target === null
                ? null
                : { ...evidence.semanticEvidence.target },
          },
    semanticFailure: cloneFailure(evidence.semanticFailure),
    typeScriptResolution: cloneTypeScriptResolution(
      evidence.typeScriptResolution,
    ),
  };
}
