import type { TaskProgressReporter } from '../../execution/progress';
import type { ExecutionAdmission } from '../admission/execution-admission';
import {
  runCheckerTargetProcess,
  startCheckerTargetAdmission,
} from '../runner-shared';
import type {
  BuildTargetCompletion,
  TypecheckRunner,
  TypecheckTarget,
} from '../targets';

export async function executeAuthorizedTypecheck(
  options: {
    admission: ExecutionAdmission;
    progress?: TaskProgressReporter;
    signal?: AbortSignal;
  },
  target: TypecheckTarget,
  runner: TypecheckRunner,
): Promise<BuildTargetCompletion> {
  let hasLaunched = false;
  let finishAdmission = startCheckerTargetAdmission(options.progress);
  try {
    return await options.admission.withManagedWrites(
      target,
      new Set(),
      async () => {
        const authorized = await options.admission.withAuthorizedTarget(
          target,
          'launch',
          async (permit) => {
            await options.admission.assertPermit(permit, target, 'launch');
            hasLaunched = true;
            const admissionTiming = finishAdmission;
            finishAdmission = undefined;
            return runCheckerTargetProcess({
              finishAdmission: admissionTiming,
              progress: options.progress,
              runner,
              signal: options.signal,
              target,
            });
          },
        );
        return authorized.state === 'refused'
          ? authorized.rejection
          : authorized.value;
      },
    );
  } catch (error) {
    assertNotLaunched(hasLaunched, error);
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
  } finally {
    finishAdmission?.('fail');
  }
}

function assertNotLaunched(hasLaunched: boolean, error: unknown): void {
  if (hasLaunched) throw error;
}
