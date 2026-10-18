import type { ResolvedCheckerModuleName } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { TypeEvidence } from '../type-evidence/cache';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import { requestEligibility } from '../typescript-semantic/request-eligibility';
import type {
  FrameworkSemanticCandidate,
  PreparedDependencyFact,
} from './contracts';
export { observeFrameworkTypeEvidence } from './provider-observation';

export interface ResolvedFrameworkCandidate {
  candidate: FrameworkSemanticCandidate<
    ts.SourceFile,
    ts.StringLiteralLike,
    unknown
  >;
  resolutionMode: string;
  target: ResolvedCheckerModuleName | null;
}

function cloneManagedSource(
  value: Extract<
    TypeEvidence,
    { kind: 'concrete-declaration' }
  >['managedSource'],
) {
  return value === undefined
    ? undefined
    : { ...value, checkerNames: [...value.checkerNames] };
}

export function cloneTypeEvidence(evidence: TypeEvidence): TypeEvidence;
export function cloneTypeEvidence(
  evidence: TypeEvidence | undefined,
): TypeEvidence | undefined;
export function cloneTypeEvidence(
  evidence: TypeEvidence | undefined,
): TypeEvidence | undefined {
  return evidence === undefined
    ? undefined
    : cloneObservedTypeEvidence(evidence);
}
function cloneObservedTypeEvidence(evidence: TypeEvidence): TypeEvidence {
  if (evidence.kind === 'ambient') {
    return {
      ...evidence,
      declarationFilePaths: [...evidence.declarationFilePaths],
    };
  }
  if (evidence.kind === 'concrete-declaration') {
    return {
      ...evidence,
      managedSource: cloneManagedSource(evidence.managedSource),
    };
  }
  return { ...evidence };
}

interface PreparedFactOptions {
  checkerName: string;
  managedOutputLookup: ManagedOutputDeclarationLookup | undefined;
  program: ts.Program | undefined;
  resolved: ResolvedFrameworkCandidate;
  tsModule: typeof ts;
}
export function requiresReferenceStructure(
  target: ResolvedCheckerModuleName | null,
): boolean {
  return target !== null && !isDeclarationFile(target.resolvedFileName);
}
export function createPreparedFact(
  options: PreparedFactOptions,
): PreparedDependencyFact {
  const { candidate, target } = options.resolved;
  const redirect = preparedRedirect(options);
  return {
    eligibility: requestEligibility(
      candidate.containingSourceFile,
      candidate.sourceRecord,
      options.tsModule,
    ),
    redirect,
    framework: candidate.framework,
    importRecord: {
      ...candidate.sourceRecord,
      locator: { ...candidate.sourceRecord.locator },
      specifier: candidate.semanticSpecifier,
    },
    provenance: candidate.provenance,
    resolutionMode: options.resolved.resolutionMode,
    semanticSpecifier: candidate.semanticSpecifier,
    target: target === null ? null : structuredClone(target),
  };
}

function canonicalManagedSource(
  evidence: Extract<TypeEvidence, { kind: 'concrete-declaration' }>,
): unknown {
  const source = evidence.managedSource;
  if (source === undefined) return null;
  return {
    checkerNames: [...source.checkerNames].sort(compareCodeUnits),
    declarationFilePath: normalizeAbsolutePathIdentity(
      source.declarationFilePath,
    ),
    mappedSourceFilePath: normalizeAbsolutePathIdentity(
      source.mappedSourceFilePath,
    ),
    reason: source.reason,
    sourceConfigPath: normalizeAbsolutePathIdentity(source.sourceConfigPath),
  };
}

function canonicalTerminalEvidence(
  evidence: Extract<TypeEvidence, { kind: 'missing' | 'unsupported-checker' }>,
): string {
  return evidence.kind === 'missing'
    ? JSON.stringify([evidence.kind])
    : JSON.stringify([evidence.kind, evidence.checker, evidence.reason]);
}

function canonicalNonAmbientEvidence(
  evidence: Exclude<TypeEvidence, { kind: 'ambient' }>,
): string {
  if (evidence.kind === 'checker-source') {
    return JSON.stringify([
      evidence.kind,
      normalizeAbsolutePathIdentity(evidence.filePath),
    ]);
  }
  if (evidence.kind === 'concrete-declaration') {
    return JSON.stringify([
      evidence.kind,
      normalizeAbsolutePathIdentity(evidence.filePath),
      canonicalManagedSource(evidence),
    ]);
  }
  return canonicalTerminalEvidence(evidence);
}

export function canonicalTypeEvidenceIdentity(
  evidence: TypeEvidence | undefined,
): string {
  if (evidence === undefined) return 'unobserved';
  if (evidence.kind !== 'ambient') return canonicalNonAmbientEvidence(evidence);
  return JSON.stringify([
    evidence.kind,
    evidence.modulePattern,
    evidence.declarationFilePaths
      .map(normalizeAbsolutePathIdentity)
      .sort(compareCodeUnits),
  ]);
}

function preparedRedirect(
  options: PreparedFactOptions,
): ReturnType<typeof observeProjectReferenceRedirect> {
  return options.resolved.target === null
    ? undefined
    : redirectWithProgram(options, options.resolved.target.resolvedFileName);
}
function redirectWithProgram(
  options: PreparedFactOptions,
  target: string,
): ReturnType<typeof observeProjectReferenceRedirect> {
  return options.program === undefined
    ? undefined
    : observeProjectReferenceRedirect(
        options.program,
        target,
        options.tsModule,
      );
}
