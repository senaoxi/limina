import type { ExecutionAdmission } from '../admission/execution-admission';
import {
  type BuildTargetCompletion,
  runTargetWithMeasuredDuration,
  type TypecheckRunner,
  type TypecheckTarget,
} from '../targets';

export async function executeAuthorizedTypecheck(
  options: { admission: ExecutionAdmission; signal?: AbortSignal },
  target: TypecheckTarget,
  runner: TypecheckRunner,
): Promise<BuildTargetCompletion> {
  let hasLaunched = false;
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
            return runTargetWithMeasuredDuration(
              runner,
              target,
              options.signal,
            );
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
  }
}

function assertNotLaunched(hasLaunched: boolean, error: unknown): void {
  if (hasLaunched) throw error;
}
