import type {
  NativeCompilationObligation,
  ObligationExistence,
} from '../../domain/analysis/native-obligation';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { nativeFingerprint } from './native-file-identity';
import type { NativeRequestResult } from './native-program-request-data';

/**
 * Requests outside module inventory must retain an obligation assessment too.
 * An observed declaration is consumption evidence, never a guessed producer.
 * Unproved implementation/path effects stay unknown for downstream admission.
 */
export function remainingNativeObligations(
  entries: readonly NativeRequestResult[],
  modules: readonly NativeCompilationObligation[],
): NativeCompilationObligation[] {
  const assessed = new Set(modules.flatMap((item) => item.requestIds));
  return entries
    .filter((entry) => !assessed.has(entry.request.id))
    .map(requestObligation);
}

function requestObligation(
  entry: NativeRequestResult,
): NativeCompilationObligation {
  const { request } = entry;
  const context = request.origin.context;
  const existence = requestExistence(entry);
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
