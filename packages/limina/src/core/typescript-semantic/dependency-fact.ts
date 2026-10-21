import type ts from 'typescript';
import type { NativeEvidenceOrigin } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import {
  decideReferenceRequirement,
  type DeclarationReferenceRequirement,
} from '../dependency-semantics';
import type { ImportRecord } from '../import-analysis/records';
import { getResolvedTargetKind } from '../import-graph/declaration-classifier';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticResolution,
} from './contracts';
import { isOriginalTargetInProgram } from './provider-evidence';
import { observeProjectReferenceRedirect } from './reference-redirect';
import { requestEligibility } from './request-eligibility';
export type { DeclarationReferenceRequirement } from '../dependency-semantics';

export interface NativeDependencyFact {
  nativeEvidence?: {
    requestId: string;
    origin: NativeEvidenceOrigin;
    coverage: NativeCoverage | null;
    obligation: NativeCompilationObligation | null;
  };
  eligibility?: { governance: boolean; expansion: boolean };
  admission: 'admitted' | 'excluded' | 'unresolved';
  referenceRequirement: DeclarationReferenceRequirement | null;
  resolution: TypeScriptSemanticResolution;
  typeEvidence?: TypeEvidence;
  redirect?: ProjectReferenceRedirect;
}

export function hasDeclarationResolution(
  resolution: TypeScriptSemanticResolution,
): boolean {
  return (
    resolution.target !== null &&
    getResolvedTargetKind(resolution.target.resolvedFileName) === 'declaration'
  );
}

function getAdmission(
  context: TypeScriptSemanticContext,
  resolution: TypeScriptSemanticResolution,
  tsModule: typeof ts,
): NativeDependencyFact['admission'] {
  if (resolution.target === null) return 'unresolved';
  return isOriginalTargetInProgram({
    context,
    target: resolution.target.resolvedFileName,
    tsModule,
  })
    ? 'admitted'
    : 'excluded';
}

export function collectNativeDependencyFact(options: {
  getAmbientEvidence: typeof createAmbientTypeEvidence;
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  tsModule: typeof ts;
}): NativeDependencyFact {
  const resolution = options.context.resolveImportRecord(options.record);
  const redirect = resolvedRedirect(options, resolution);
  const decision = decideReferenceRequirement({
    target: requestEligibility(
      options.context.getSourceFile(options.record.filePath)!,
      options.record,
      options.tsModule,
    ).governance
      ? resolution.target
      : null,
    redirect,
  });
  if (decision.state === 'pending')
    throw new Error(
      `Native dependency observation is incomplete: ${decision.need}`,
    );
  return {
    eligibility: requestEligibility(
      options.context.getSourceFile(options.record.filePath)!,
      options.record,
      options.tsModule,
    ),
    admission: getAdmission(options.context, resolution, options.tsModule),
    referenceRequirement: decision.value,
    resolution,
    redirect,
  };
}

function resolvedRedirect(
  options: Parameters<typeof collectNativeDependencyFact>[0],
  resolution: TypeScriptSemanticResolution,
): ProjectReferenceRedirect | undefined {
  return resolution.target === null
    ? undefined
    : observeProjectReferenceRedirect(
        options.context.program,
        resolution.target.resolvedFileName,
        options.tsModule,
      );
}
