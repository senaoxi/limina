import type { ResolvedCheckerModuleName } from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import type { TypeEvidence } from '../type-evidence/cache';

export type FrameworkSemanticKind = 'astro' | 'svelte' | 'vue';

export type FrameworkSemanticProvenance = 'direct-source' | 'strict-source-map';

export interface FrameworkSemanticCandidate<
  SourceFile,
  Literal,
  Profile = never,
> {
  containingSourceFile: SourceFile;
  framework: FrameworkSemanticKind;
  identityId: string;
  literal: Literal;
  profile?: Profile;
  provenance: FrameworkSemanticProvenance;
  semanticSpecifier: string;
  sourceRecord: ImportRecord;
}

export interface FrameworkSemanticEvidence<Profile = unknown> {
  framework: FrameworkSemanticKind;
  identityId: string;
  profile?: Profile;
  provenance: FrameworkSemanticProvenance;
  resolutionMode: string;
  semanticSpecifier: string;
  sourceRecord: ImportRecord;
  target: ResolvedCheckerModuleName | null;
}

export interface PreparedDependencyFact {
  framework: FrameworkSemanticKind;
  importRecord: ImportRecord;
  provenance: 'strict-source-map';
  resolutionMode: string;
  semanticSpecifier: string;
  target: ResolvedCheckerModuleName | null;
  typeEvidence: TypeEvidence;
}

export interface FrameworkSemanticUnmappedGeneratedDependency {
  generatedFilePath: string;
  semanticSpecifier: string;
}

export type FrameworkSemanticDependencyPreparation =
  | {
      directSourceRecords: ImportRecord[];
      facts: PreparedDependencyFact[];
      kind: 'supported';
      unmapped: FrameworkSemanticUnmappedGeneratedDependency[];
    }
  | {
      kind: 'unsupported';
      reason: string;
      stage: Extract<
        FrameworkSemanticFailureStage,
        | 'context-creation'
        | 'service-script-materialization'
        | 'source-map-ambiguity'
        | 'source-map-mismatch'
        | 'toolchain-compatibility'
        | 'toolchain-resolution'
      >;
    };

export type FrameworkSemanticFailureStage =
  | 'context-creation'
  | 'module-resolution'
  | 'service-script-materialization'
  | 'source-map-ambiguity'
  | 'source-map-mismatch'
  | 'toolchain-compatibility'
  | 'toolchain-resolution';

export interface FrameworkSemanticFailure {
  framework: FrameworkSemanticKind;
  reason: string;
  scopeIdentity: string;
  stage: FrameworkSemanticFailureStage;
}

export class FrameworkSemanticResolutionError extends Error {
  readonly failure: FrameworkSemanticFailure;

  constructor(options: { failure: FrameworkSemanticFailure; message: string }) {
    super(options.message);
    this.name = 'FrameworkSemanticResolutionError';
    this.failure = createFrameworkSemanticFailure(options.failure);
  }
}

export function createFrameworkSemanticEvidence<Profile>(options: {
  candidate: FrameworkSemanticCandidate<unknown, unknown, Profile>;
  resolutionMode: string;
  target: ResolvedCheckerModuleName | null;
}): FrameworkSemanticEvidence<Profile> {
  return {
    framework: options.candidate.framework,
    identityId: options.candidate.identityId,
    profile: options.candidate.profile,
    provenance: options.candidate.provenance,
    resolutionMode: options.resolutionMode,
    semanticSpecifier: options.candidate.semanticSpecifier,
    sourceRecord: {
      ...options.candidate.sourceRecord,
      locator: { ...options.candidate.sourceRecord.locator },
    },
    target: options.target === null ? null : { ...options.target },
  };
}

export function createFrameworkSemanticFailure(
  failure: FrameworkSemanticFailure,
): FrameworkSemanticFailure {
  return { ...failure };
}

export function formatFrameworkSemanticFailure(
  failure: FrameworkSemanticFailure,
): string {
  return failure.reason;
}

export function getFrameworkSemanticFailureIdentity(
  failure: FrameworkSemanticFailure,
): string {
  return JSON.stringify({
    framework: failure.framework,
    scopeIdentity: failure.scopeIdentity,
    stage: failure.stage,
  });
}
