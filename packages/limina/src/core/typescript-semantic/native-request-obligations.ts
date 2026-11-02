import { normalizeAbsolutePath } from '#utils/path';
import type {
  NativeCompilationObligation,
  ObligationExistence,
} from '../../domain/analysis/native-obligation';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from './compiler-coverage';
import { nativeFingerprint } from './native-file-identity';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeRequestResult } from './native-program-request-data';

/**
 * Requests outside module inventory must retain an obligation assessment too.
 * An observed declaration is consumption evidence, never a guessed producer.
 * Unproved implementation/path effects stay unknown for downstream admission.
 */
export function remainingNativeObligations(
  entries: readonly NativeRequestResult[],
  modules: readonly NativeCompilationObligation[],
  program: NativeObservedProgram,
  frontier: NativeProgramFrontier,
): NativeCompilationObligation[] {
  const assessed = new Set(modules.flatMap((item) => item.requestIds));
  return entries
    .filter((entry) => !assessed.has(entry.request.id))
    .map((entry) => requestObligation(entry, program, frontier));
}

function requestObligation(
  entry: NativeRequestResult,
  program: NativeObservedProgram,
  frontier: NativeProgramFrontier,
): NativeCompilationObligation {
  const { request } = entry;
  const context = request.origin.context;
  const existence =
    typeInputExistence(entry, program, frontier) ?? requestExistence(entry);
  const reason =
    existence.state === 'absent'
      ? {
          state: 'not-applicable' as const,
          reason: 'no-proven-compilation-obligation',
        }
      : { state: 'unknown' as const, reason: 'request-effect-not-proved' };
  return {
    id: nativeFingerprint(['compilation-obligation', request.id]),
    requestIds: [request.id],
    consumerContextId: context.id,
    consumerConfigId: context.inputs.config,
    rawReferenceFingerprint: context.inputs.rawReferences,
    targetConfigId: null,
    existence,
    structure: reason,
    artifact: reason,
  };
}

function requestExistence(entry: NativeRequestResult): ObligationExistence {
  const rule = absenceRule(entry);
  return rule === undefined
    ? {
        state: 'unknown',
        gapIds: [entry.request.id],
      }
    : {
        state: 'absent',
        proof: {
          kind: 'audited-rule',
          evidenceId: entry.request.id,
          contextId: entry.request.consumerContextId,
          ruleOrObservation: rule,
        },
      };
}

function absenceRule(entry: NativeRequestResult): string | undefined {
  return entry.resolution.state === 'unresolved'
    ? 'compiler-completed-resolution-without-file-input'
    : declarationAbsence(entry);
}

function declarationAbsence(entry: NativeRequestResult): string | undefined {
  if (entry.resolution.target === null) return undefined;
  return isDeclarationFile(entry.resolution.target.lexicalPath)
    ? 'declaration-consumption-does-not-establish-a-producer'
    : undefined;
}

function typeInputExistence(
  entry: NativeRequestResult,
  program: NativeObservedProgram,
  frontier: NativeProgramFrontier,
): ObligationExistence | undefined {
  const { request, resolution } = entry;
  if (
    request.channel !== 'type-directive' ||
    resolution.state !== 'resolved' ||
    resolution.target === null ||
    isDeclarationFile(resolution.target.lexicalPath)
  )
    return undefined;
  const key = (file: string) => compilerFileKey(normalizeAbsolutePath(file));
  const target = key(resolution.target.lexicalPath);
  const isRoot = program
    .getRootFileNames()
    .some((file) => key(file) === target);
  const isDisabled =
    request.sourceFile !== null &&
    program.getCompilerOptions().noResolve === true;
  const wasAttempted = frontier.attempts.some(
    (attempt) => key(attempt.file.lexicalPath) === target,
  );
  if (
    !isRoot &&
    !isDisabled &&
    (!wasAttempted ||
      resolution.externalLibrary !== false ||
      (program.getCompilerOptions().composite !== true &&
        request.origin.context.inputs.compilationScope !==
          'generated-declaration-project-v1'))
  )
    return undefined;
  return {
    state: isRoot || isDisabled ? 'absent' : 'present',
    proof: {
      kind: 'audited-rule',
      evidenceId: request.id,
      contextId: request.consumerContextId,
      ruleOrObservation: isRoot
        ? 'type-input-is-consumer-root'
        : isDisabled
          ? 'source-type-directive-disabled-by-noResolve'
          : 'local-type-implementation-input-requires-membership',
    },
  };
}
