import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { NativeResolution } from '../../domain/analysis/native-evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from '../typescript-semantic/compiler-coverage';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { NativeObservedProgram } from '../typescript-semantic/native-program-api';
import { createNativeSemanticContext } from '../typescript-semantic/native-semantic-factory';
import { observeNativeReferenceMapping } from '../typescript-semantic/reference-redirect';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import {
  type DeclarationCandidateInput,
  type DeclarationCandidateObservation,
  declarationCandidateRequests,
  DeclarationObservationUnavailable,
} from './candidate';
import { observeNativeImplementationCandidate } from './native-implementation-candidate';

const requireFromLimina = createRequire(import.meta.url);

export function observeNativeDeclarationCandidate(
  input: DeclarationCandidateInput,
): DeclarationCandidateObservation {
  if (input.declarations.length === 0 && input.referenceInputs?.length)
    return observeNativeImplementationCandidate(input);
  // With no project references the TS 6.0.3 reference map is empty. Every
  // requested mapping is a verified parsed root and its locked inventory has
  // no internal request. The same compiler can establish this from metadata.
  if (
    input.emptyLocalRootInventory &&
    ts.version === '6.0.3' &&
    !input.requiresDelegationProof &&
    !input.referenceInputs?.length &&
    !input.parsed.projectReferences?.length &&
    input.declarations.every(
      (file) =>
        /\.d\.[cm]?ts$/iu.test(file) &&
        input.parsed.fileNames.some(
          (root) => compilerFileKey(root) === compilerFileKey(file),
        ),
    )
  ) {
    input.metrics?.record({
      name: 'declaration-candidate',
      kind: 'compiler-membership',
      count: 1,
    });
    return {
      authority: nativeCandidateAuthority(
        input.checker,
        'typescript-local-root-membership-v1',
      ),
      contextId: nativeFingerprint([
        input.emptyLocalRootInventory,
        input.generatedConfig,
        input.declarations,
      ]),
      compilerVersion: ts.version,
      sources: input.declarations.map((file) => ({
        file,
      })),
      mappings: input.declarations.map((file) => ({
        file,
        referenceConfig: null,
        declarationOutput: null,
        qualified: true,
      })),
      requests: [],
    };
  }
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
    // Query membership with the same Compiler Host key as the observation.
    const declarations = new Set(
      context.program
        .getSourceFiles()
        .filter((source) => isDeclarationFile(source.fileName))
        .map((source) => compilerFileKey(source.fileName)),
    );
    const resolutions = new Map(
      snapshot.resolutions.map((resolution) => [
        resolution.requestId,
        resolution,
      ]),
    );
    return {
      authority: nativeCandidateAuthority(
        input.checker,
        'typescript-declaration-candidate-v1',
      ),
      contextId: snapshot.contexts[0]!.id,
      compilerVersion: ts.version,
      sources: context.program.getSourceFiles().map((source) => ({
        file: normalizeAbsolutePath(source.fileName),
        defaultLibrary: source.hasNoDefaultLib,
      })),
      mappings: [
        ...new Set([
          ...input.declarations,
          ...(input.referenceInputs ?? []),
          ...snapshot.resolutions.flatMap((resolution) =>
            resolution.target === null ? [] : [resolution.target.lexicalPath],
          ),
        ]),
      ].map((file) => {
        const mapping = observeNativeReferenceMapping(
          context.program,
          file,
          ts,
        );
        return {
          file,
          referenceConfig: mapping.referenceConfig ?? null,
          declarationOutput: mapping.declarationOutput ?? null,
          qualified: mapping.qualified,
        };
      }),
      requests: declarationCandidateRequests(
        input.declarations,
        snapshot.requests.flatMap((request) => {
          const file = request.sourceFile?.lexicalPath;
          if (file === undefined || !declarations.has(compilerFileKey(file)))
            return [];
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
              ...referencedPathInput(context.program, resolution),
              redirects: resolution.rawRedirectEvidenceIds,
              environment: effectiveCompilerOptions(environment),
              externalLibrary: resolution.externalLibrary,
            },
          ];
        }),
        compilerFileKey,
      ),
    };
  } finally {
    context.dispose();
  }
}

/** Qualify this occurrence against the generated Program's own redirect.
 * Preserve the raw lookup in the receipt for output and execution checks. */
function referencedPathInput(
  program: ts.Program,
  resolution: NativeResolution,
) {
  const selection = resolution.pathSelection;
  const source = selection?.logicalTarget;
  if (
    !source ||
    isDeclarationFile(source) ||
    resolution.rawRedirectEvidenceIds.length !== 1
  )
    return {};
  const mapping = observeNativeReferenceMapping(program, source, ts);
  if (
    !mapping.qualified ||
    !mapping.declarationOutput ||
    mapping.referenceConfig !== resolution.rawRedirectEvidenceIds[0]
  )
    return {};
  const output = compilerFileKey(mapping.declarationOutput);
  const candidate = selection.candidates.find(
    (entry) =>
      compilerFileKey(entry.lexicalPath) === compilerFileKey(source) &&
      compilerFileKey(entry.physicalPath) === output,
  );
  if (!candidate) return {};
  const isQualified = candidate.present
    ? selection.state === 'selected' &&
      resolution.state === 'resolved' &&
      resolution.target !== null &&
      compilerFileKey(resolution.target.lexicalPath) === output
    : selection.state === 'missing' &&
      resolution.state === 'unresolved' &&
      resolution.target === null;
  return isQualified ? { referencedPathInput: source } : {};
}

function nativeCandidateAuthority(checker: string, adapter: string) {
  return {
    checker,
    adapter,
    toolchain: nativeFingerprint([
      requireFromLimina.resolve('typescript'),
      ts.version,
    ]),
    executionEntry: requireFromLimina.resolve('typescript/bin/tsc'),
  };
}
