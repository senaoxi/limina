import type { ResolvedCheckerModuleName } from '#checkers';
import { isDeclarationFile } from './import-graph/declaration-classifier';
import type { TypeEvidence } from './type-evidence/cache';

export interface DeclarationReferenceRequirement {
  kind: 'source-semantic' | 'compiler-membership';
  targetFileName: string;
}
export type CompilerMembership = 'covered' | 'not-covered' | 'unobserved';
export interface ProjectReferenceRedirect {
  originalTarget: string;
  declarationTarget: string;
  referenceConfig: string;
  availability: 'present' | 'missing';
}
export type RequirementDecision =
  | { state: 'pending'; need: 'resolution-observation' }
  | { state: 'decided'; value: DeclarationReferenceRequirement | null };

/**
Resolution and explicit reference structure own graph obligations.
*/
export function decideReferenceRequirement(options: {
  target: ResolvedCheckerModuleName | null;
  redirect?: ProjectReferenceRedirect;
  coverage?: 'complete' | 'unobserved' | 'unsupported' | 'failed';
  typeEvidence?: TypeEvidence;
  compilerMembership?: CompilerMembership;
}): RequirementDecision {
  if (!hasCompleteCoverage(options.coverage))
    return { state: 'pending', need: 'resolution-observation' };
  const target = options.target;
  return {
    state: 'decided',
    value: hasNoSourceRequirement(target, options.redirect)
      ? null
      : { kind: 'source-semantic', targetFileName: target!.resolvedFileName },
  };
}

export function pendingRequirementReason(
  decision: Extract<RequirementDecision, { state: 'pending' }>,
): string {
  return `Dependency requirement needs ${decision.need}.`;
}

function hasCompleteCoverage(
  coverage: Parameters<typeof decideReferenceRequirement>[0]['coverage'],
): boolean {
  return coverage === undefined || coverage === 'complete';
}
function hasNoSourceRequirement(
  target: ResolvedCheckerModuleName | null,
  redirect: ProjectReferenceRedirect | undefined,
): boolean {
  return (
    target === null ||
    [redirect !== undefined, isDeclarationFile(target.resolvedFileName)].some(
      Boolean,
    )
  );
}
