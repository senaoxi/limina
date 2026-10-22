import type { CheckerFailureKind, CheckerFailureTarget } from '../runner-types';
import type { BuildTargetCompletion, TypecheckTarget } from '../target-types';
import type { ExecutionAdmissionRejection } from './types';

export function executionFailureKind(
  failed: readonly unknown[],
  refused: readonly unknown[],
): CheckerFailureKind | undefined {
  if (failed.length > 0) return 'process';
  return refused.length > 0 ? 'execution-admission' : undefined;
}
export function admissionFailureTargets(
  targets: readonly TypecheckTarget[],
  results: readonly BuildTargetCompletion[],
): CheckerFailureTarget[] {
  return results.flatMap((result) => failureForTarget(targets, result));
}
function failureForTarget(
  targets: readonly TypecheckTarget[],
  result: BuildTargetCompletion,
): CheckerFailureTarget[] {
  if (typeof result.status === 'number') return [];
  const target = targets.find((item) => item.id === result.id);
  return target === undefined ? [] : [targetFailure(target, result)];
}
function targetFailure(
  target: TypecheckTarget,
  result: Exclude<BuildTargetCompletion, { status: number }>,
): CheckerFailureTarget {
  return {
    id: result.id,
    checkerName: target.checkerName,
    configPath: target.configPath,
    ...(result.status === 'admission-rejected'
      ? {
          admission: result,
          message: result.diagnostics.map((item) => item.message).join('\n'),
        }
      : {
          blockedByTarget: result.blockedBy,
          message: 'Required execution prerequisite failed.',
        }),
  };
}

export function rejectedBeforeLaunch(
  target: TypecheckTarget,
  error: unknown,
): ExecutionAdmissionRejection {
  return {
    status: 'admission-rejected',
    id: target.id,
    decision: 'unavailable',
    stage: 'launch',
    diagnostics: [
      {
        code: 'LIMINA_EXECUTION_INPUT_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
