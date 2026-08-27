import type {
  AstroMaterializedProject,
  ResolvedCheckerModuleName,
} from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { createFrameworkSemanticEvidence } from '../framework-semantic/contracts';
import type { AstroSemanticContextManager } from './context';
import type { AstroSemanticCandidate } from './dependency';
import type { AstroSemanticResolution } from './resolution-types';

export interface ResolvedCandidate {
  candidate: AstroSemanticCandidate;
  mode: string;
  resolution: ResolvedCheckerModuleName | null;
}

function getResolutionMode(options: {
  candidate: AstroSemanticCandidate;
  compilerOptions: ts.CompilerOptions;
  tsModule: typeof ts;
}): string {
  return String(
    options.tsModule.getModeForUsageLocation(
      options.candidate.containingSourceFile,
      options.candidate.literal,
      options.compilerOptions,
    ),
  );
}

function isCheckerSourcePath(options: {
  fileName: string;
  project: AstroMaterializedProject;
}): boolean {
  const normalized = options.fileName.toLowerCase();
  return [
    '.astro',
    '.svelte',
    '.vue',
    ...options.project.snapshot.checkerExtensions,
  ].some((extension) => normalized.endsWith(extension.toLowerCase()));
}

function createCheckerResolution(options: {
  project: AstroMaterializedProject;
  resolvedModule: ts.ResolvedModuleFull;
}): ResolvedCheckerModuleName {
  const resolvedFileName = normalizeAbsolutePath(
    options.resolvedModule.resolvedFileName,
  );
  return {
    isExternalLibraryImport:
      options.resolvedModule.isExternalLibraryImport === true,
    resolvedBy: isCheckerSourcePath({
      fileName: resolvedFileName,
      project: options.project,
    })
      ? 'checker-source'
      : 'typescript',
    resolvedFileName,
  };
}

function getCandidateResolutionIdentity(
  resolution: ResolvedCheckerModuleName | null,
): readonly [string | null, string | null] {
  if (resolution === null) return [null, null];
  return [resolution.resolvedFileName, resolution.resolvedBy];
}

function canonicalCandidate(candidate: ResolvedCandidate): string {
  return JSON.stringify([
    candidate.candidate.semanticSpecifier,
    candidate.mode,
    ...getCandidateResolutionIdentity(candidate.resolution),
  ]);
}

export function selectCanonicalAstroCandidate(
  candidates: readonly ResolvedCandidate[],
): AstroSemanticResolution {
  const first = candidates[0];
  if (first === undefined) {
    return {
      kind: 'unsupported',
      reason: 'Astro semantic dependency produced no real-source candidate.',
      stage: 'source-map-mismatch',
    };
  }
  const identity = canonicalCandidate(first);
  if (
    !candidates.every((candidate) => canonicalCandidate(candidate) === identity)
  ) {
    return {
      kind: 'unsupported',
      reason:
        'Astro source-map candidates did not agree on semantic specifier, resolution mode, and canonical target.',
      stage: 'source-map-mismatch',
    };
  }
  return {
    evidence: createFrameworkSemanticEvidence({
      candidate: first.candidate,
      resolutionMode: first.mode,
      target: first.resolution,
    }),
    kind: 'resolved',
    resolution: first.resolution,
  };
}

function createCandidateResolution(options: {
  project: AstroMaterializedProject;
  resolvedModule: ts.ResolvedModuleFull | undefined;
}): ResolvedCheckerModuleName | null {
  if (options.resolvedModule === undefined) return null;
  return createCheckerResolution({
    project: options.project,
    resolvedModule: options.resolvedModule,
  });
}

export function createResolvedAstroCandidate(options: {
  candidate: AstroSemanticCandidate;
  context: ReturnType<AstroSemanticContextManager['acquire']>;
  resolvedByLiteral: ReadonlyMap<
    ts.StringLiteralLike,
    ts.ResolvedModuleWithFailedLookupLocations
  >;
}): ResolvedCandidate {
  return {
    candidate: options.candidate,
    mode: getResolutionMode({
      candidate: options.candidate,
      compilerOptions:
        options.context.languageServiceHost.getCompilationSettings(),
      tsModule: options.context.toolchain.tsModule,
    }),
    resolution: createCandidateResolution({
      project: options.context.project,
      resolvedModule: options.resolvedByLiteral.get(options.candidate.literal)
        ?.resolvedModule,
    }),
  };
}
