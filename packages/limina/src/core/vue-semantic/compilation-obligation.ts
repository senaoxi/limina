import type ts from 'typescript';
import type { CompilationObligationProof } from '../dependency-semantics';
import {
  independentModuleAbsence,
  observeNativeModuleImpact,
} from '../typescript-semantic/native-module-impact';
import { nativeObservedProgram } from '../typescript-semantic/native-program-api';
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
  const impact = observeNativeModuleImpact({
    program,
    observation,
    compiler: context.tsModule,
    reference,
  });
  // A reference membership proof can qualify JS input before native filename
  // classification. Foreign framework targets still need a matching service.
  if (
    impact.state === 'present' &&
    !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(target.resolvedFileName) &&
    !isQualifiedService(context, target)
  )
    return {
      state: 'unknown' as const,
      reason: 'framework-service-classification-unavailable',
    };
  return impact.state === 'unknown' &&
    impact.reason === 'target-emission-rule-unqualified-for-extension' &&
    isQualifiedService(context, target)
    ? {
        state: 'present' as const,
        rule: 'vue-service-script-declaration-input',
      }
    : impact;
}

function isQualifiedService(
  context: VueSemanticContext,
  target: ts.ResolvedModuleFull,
): boolean {
  const service = getVueServiceScript({
    context,
    fileName: target.resolvedFileName,
  })?.serviceScript;
  if (service === undefined || service.extension !== target.extension)
    return false;
  const { Extension, ScriptKind } = context.tsModule;
  return (
    new Map<string, number>([
      [Extension.Ts, ScriptKind.TS],
      [Extension.Tsx, ScriptKind.TSX],
      [Extension.Js, ScriptKind.JS],
      [Extension.Jsx, ScriptKind.JSX],
    ]).get(service.extension) === service.scriptKind
  );
}
