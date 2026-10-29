import { createRequire } from 'node:module';
import ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { NativeObservedProgram } from '../typescript-semantic/native-program-api';
import { createNativeSemanticContext } from '../typescript-semantic/native-semantic-factory';
import { observeNativeReference } from '../typescript-semantic/reference-redirect';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import {
  type DeclarationCandidateInput,
  type DeclarationCandidateObservation,
  declarationCandidateRequests,
  DeclarationObservationUnavailable,
} from './candidate';

const requireFromLimina = createRequire(import.meta.url);

export function observeNativeDeclarationCandidate(
  input: DeclarationCandidateInput,
): DeclarationCandidateObservation {
  const context = createNativeSemanticContext(
    {
      configPath: input.generatedConfig,
      fileNames: input.parsed.fileNames,
      options: input.parsed.options,
      projectReferences: input.parsed.projectReferences,
      virtualFiles: input.files,
      declarationContextValidation: {
        sourceConfig: input.sourceConfig,
        allowedDeclarations: input.declarations,
      },
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        input.roots,
        undefined,
        input.coverage,
      ),
    },
    undefined,
    input.metrics,
  );
  try {
    const snapshot = context.nativeEvidence!;
    if (snapshot.run !== 'completed' || snapshot.failures.length > 0)
      throw new DeclarationObservationUnavailable(
        snapshot.failures[0]?.detail ??
          'Candidate declaration observation is incomplete.',
      );
    const declarations = new Set(
      context.program
        .getSourceFiles()
        .filter((source) => isDeclarationFile(source.fileName))
        .map((source) => source.fileName),
    );
    const resolutions = new Map(
      snapshot.resolutions.map((resolution) => [
        resolution.requestId,
        resolution,
      ]),
    );
    return {
      authority: {
        checker: input.checker,
        adapter: 'typescript-declaration-candidate-v1',
        toolchain: nativeFingerprint([
          requireFromLimina.resolve('typescript'),
          ts.version,
        ]),
        executionEntry: requireFromLimina.resolve('typescript/bin/tsc'),
      },
      contextId: snapshot.contexts[0]!.id,
      compilerVersion: ts.version,
      sources: context.program.getSourceFiles().map((source) => ({
        file: source.fileName,
        defaultLibrary: source.hasNoDefaultLib,
      })),
      mappings: [
        ...new Set([
          ...input.declarations,
          ...snapshot.resolutions.flatMap((resolution) =>
            resolution.target === null ? [] : [resolution.target.lexicalPath],
          ),
        ]),
      ].map((file) => {
        const mapping = observeNativeReference(context.program, file, ts);
        return {
          file,
          referenceConfig:
            mapping.state === 'observed'
              ? (mapping.referenceConfig ?? null)
              : null,
          declarationOutput:
            mapping.state === 'observed'
              ? (mapping.redirect?.declarationTarget ?? null)
              : null,
          qualified:
            mapping.state === 'observed' && mapping.canProveMissingReference,
        };
      }),
      requests: declarationCandidateRequests(
        input.declarations,
        snapshot.requests.flatMap((request) => {
          const file = request.sourceFile?.lexicalPath;
          if (file === undefined || !declarations.has(file)) return [];
          if (
            snapshot.contexts.length !== 1 ||
            request.consumerContextId !== snapshot.contexts[0]!.id
          )
            throw new DeclarationObservationUnavailable(
              `Unbound declaration request: ${request.specifier}`,
            );
          const resolution = resolutions.get(request.id);
          if (resolution === undefined || resolution.state === 'unavailable')
            throw new DeclarationObservationUnavailable(
              `Unavailable declaration request: ${request.specifier}`,
            );
          const source = context.program.getSourceFile(file)!;
          const environment = ['library', 'path-directive'].includes(
            request.channel,
          )
            ? context.program.getCompilerOptions()
            : (
                context.program as NativeObservedProgram
              ).getCompilerOptionsForFile(source);
          if (environment === undefined)
            throw new DeclarationObservationUnavailable(
              `Effective declaration environment is unavailable: ${file}`,
            );
          return [
            {
              file,
              position:
                request.entry.kind === 'source' ? request.entry.position : -1,
              channel: request.channel,
              specifier: request.specifier,
              mode: request.resolutionMode,
              target: resolution.target?.lexicalPath ?? null,
              resolutionState: resolution.state,
              redirects: resolution.rawRedirectEvidenceIds,
              environment: effectiveCompilerOptions(environment),
              externalLibrary: resolution.externalLibrary,
            },
          ];
        }),
      ),
    };
  } finally {
    context.dispose();
  }
}
