import type { ExecutionAdmission } from '../admission/execution-admission';
import type { ProducerPreparation } from '../admission/execution-prerequisites';
import { ManagedCheckerMutationCoordinator } from '../managed/coordinator';
import { resolveTypecheckRunner } from '../runner-shared';
import type { BuildTargetCompletion, TypecheckTarget } from '../target-types';
import { runTargetWithMeasuredDuration } from '../targets';
import type { executeCheckerBuildTargets } from './build-execution';

export async function executeAuthorizedBuild(
  options: Parameters<typeof executeCheckerBuildTargets>[0] & {
    preparation?: ProducerPreparation;
  },
  admission: ExecutionAdmission,
  target: TypecheckTarget,
): Promise<BuildTargetCompletion> {
  const prepare = async () =>
    ManagedCheckerMutationCoordinator.create({
      artifactNamespace: options.preflight.artifactNamespace,
      checkers: options.allCheckers,
      config: options.config,
      generatedGraph: admission.graph,
      targets: [target],
      workspaceContext: await options.preflight.ensureWorkspaceValidated(),
    });
  let isLaunchedProcess = false;
  try {
    let initial: Awaited<ReturnType<typeof prepare>>;
    return await admission.withManagedWrites(
      target,
      async () => {
        // Only the initial proof is handed off. A refreshed graph needs a new
        // baseline, and layer/target checks still re-prove the live outputs.
        initial =
          options.preparation?.graph === admission.graph
            ? options.preparation.coordinator
            : await prepare();
        return new Set(initial.projectedOutputPaths(target));
      },
      async (recordWrites, releaseAtLaunch) => {
        const mutation = await admission.withAuthorizedTarget(
          target,
          'mutation',
          async (permit) => {
            await initial.beforeLayerRun([target], async () => {
              await admission.assertPermit(permit, target, 'mutation');
              recordWrites();
            });
            await initial.beforeTargetRun(target);
          },
        );
        if (mutation.state === 'refused') return mutation.rejection;
        const launched = await admission.withAuthorizedTarget(
          target,
          'launch',
          async (permit) => {
            await admission.assertPermit(permit, target, 'launch');
            isLaunchedProcess = true;
            recordWrites();
            if (options.watch === true) releaseAtLaunch();
            return runTargetWithMeasuredDuration(
              resolveTypecheckRunner(options.runnerOptions),
              target,
            );
          },
        );
        return launched.state === 'refused'
          ? launched.rejection
          : launched.value;
      },
    );
  } catch (error) {
    assertNotLaunched(isLaunchedProcess, error);
    return {
      status: 'admission-rejected',
      id: target.id,
      stage: 'mutation',
      decision: 'unavailable',
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
