import type { CompilationObligationProof } from '../dependency-semantics';
import {
  evaluateModuleImpact,
  independentModuleAbsence,
} from '../typescript-semantic/native-module-impact';
import {
  nativeCompilerApi,
  nativeObservedProgram,
} from '../typescript-semantic/native-program-api';
import {
  observedDeclarationRedirect,
  observeNativeReference,
} from '../typescript-semantic/reference-redirect';
import type { VueCompilerRequest } from './compiler-requests';
import type { VueSemanticContext } from './context';
import { getVueServiceScript } from './dependency';

export function vueCompilationObligation(
  context: VueSemanticContext,
  requests: readonly VueCompilerRequest[],
): CompilationObligationProof {
  const impacts = requests.map((request) => requestImpact(context, request));
  const states = new Set(impacts.map((impact) => impact.state));
  const state =
    states.size === 0
      ? 'absent'
      : states.size === 1
        ? impacts[0]!.state
        : 'unknown';
  return {
    state,
    contextConfig: context.identity.configPath,
    reason:
      impacts
        .map((impact) => ('rule' in impact ? impact.rule : impact.reason))
        .join('; ') || 'not-a-compiler-request',
    requests: requests.map((request) => ({
      fileName: request.generatedFilePath,
      start: request.record.locator.sourceStart,
      end: request.record.locator.sourceEnd,
      specifier: request.literal.text,
      mode: request.mode,
      role: request.role,
      target: request.raw?.resolvedModule?.resolvedFileName ?? null,
    })),
  };
}
function requestImpact(
  context: VueSemanticContext,
  request: VueCompilerRequest,
) {
  const program = nativeObservedProgram(
    context.program,
    context.tsModule,
    context.compilerRequests.optionsBySource,
  );
  const observation = {
    source: request.sourceFile,
    literal: request.literal,
    role: request.role,
    mode: request.mode,
    raw: request.raw,
    requestId: '',
  };
  const independent = independentModuleAbsence({ program, observation });
  if (independent !== undefined) return independent;
  if (request.ambient)
    return {
      state: 'absent' as const,
      rule: 'compiler-own-ambient-module-has-no-file-input',
    };
  const target = request.raw?.resolvedModule;
  if (target === undefined)
    return request.raw === undefined
      ? {
          state: 'unknown' as const,
          reason: 'compiler-resolution-observation-unavailable',
        }
      : {
          state: 'absent' as const,
          rule: 'compiler-completed-resolution-without-file-input',
        };
  const reference = observeNativeReference(
    program,
    target.resolvedFileName,
    context.tsModule,
  );
  if (observedDeclarationRedirect(reference) !== undefined)
    return {
      state: 'absent' as const,
      rule: 'original-project-reference-satisfies-input',
    };
  const service = getVueServiceScript({
    context,
    fileName: target.resolvedFileName,
  })?.serviceScript;
  return evaluateModuleImpact({
    target,
    compiler: context.tsModule,
    inputOptions: program.getCompilerOptionsForFile(request.sourceFile),
    emitOptions: program.getCompilerOptions(),
    reference,
    sourceIsExternal: program.isSourceFileFromExternalLibrary(
      request.sourceFile,
    ),
    sourceIsDeclaration: request.sourceFile.isDeclarationFile,
    excludedDocumentation:
      (request.literal.flags & 16_777_216) !== 0 &&
      !nativeCompilerApi(context.tsModule).isInJSFile(request.literal),
    service:
      service?.extension === target.extension &&
      service.scriptKind !== undefined
        ? { extension: service.extension, scriptKind: service.scriptKind }
        : undefined,
  });
}
