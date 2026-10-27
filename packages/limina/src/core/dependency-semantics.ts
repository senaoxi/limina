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
export interface CompilationObligationProof {
  state: 'present' | 'absent' | 'unknown';
  contextConfig: string;
  reason: string;
  requests: {
    fileName: string;
    start: number;
    end: number;
    specifier: string;
    mode: number | undefined;
    role: 'import' | 'augmentation' | 'path-directive' | 'type-directive';
    target: string | null;
  }[];
}
export type RequirementDecision =
  | {
      state: 'pending';
      need: 'resolution-observation' | 'compilation-obligation';
    }
  | { state: 'decided'; value: DeclarationReferenceRequirement | null };

/**
Compiler input proofs and explicit reference structure own graph obligations;
TypeEvidence cannot supply either premise.
*/
export function decideReferenceRequirement(options: {
  target: ResolvedCheckerModuleName | null;
  compilationObligation?: CompilationObligationProof;
  requireCompilationObligation?: boolean;
  redirect?: ProjectReferenceRedirect;
  coverage?: 'complete' | 'unobserved' | 'unsupported' | 'failed';
  typeEvidence?: TypeEvidence;
  compilerMembership?: CompilerMembership;
}): RequirementDecision {
  if (!hasCompleteCoverage(options.coverage))
    return {
      state: 'pending',
      need: 'resolution-observation',
    };
  if (
    (options.requireCompilationObligation &&
      options.compilationObligation === undefined) ||
    options.compilationObligation?.state === 'unknown'
  )
    return { state: 'pending', need: 'compilation-obligation' };
  if (options.compilationObligation?.state === 'absent')
    return { state: 'decided', value: null };
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
