import type { LiminaPreflightManager } from '../preflight';
import type { ExecutionAdmission } from './admission/execution-admission';
import type { AuthorizedResult } from './admission/types';
import {
  collectOutputDeclarationCopyContexts,
  createCopyPlan,
  runOutputDeclarationCopyPostBuild,
} from './build/output-copy';
import {
  type BuildTargetDescriptor,
  getOutputDeclarationCopyContexts,
} from './build/target-resolution';
import {
  collectLeafClassifications,
  collectTargetLeafConfigs,
} from './managed/config';
import type { RunCheckerBuildOptions } from './runner-types';
import type { TypecheckTarget } from './targets';

interface CopyInput {
  admission: ExecutionAdmission;
  preflight: LiminaPreflightManager;
  request: RunCheckerBuildOptions;
  projectRootDir: string;
  flowDepth: number;
}
export function coveredOutputDescriptors(
  graph: ExecutionAdmission['graph'],
  target: TypecheckTarget,
): BuildTargetDescriptor[] {
  const closure = new Set(
    collectTargetLeafConfigs({
      classifications: collectLeafClassifications(graph),
      rootConfigPath: target.configPath,
    }).leafPaths,
  );
  return graph.checkers.flatMap((checker) => {
    const modules = graph.configToOutputBuild.get(checker.name) ?? new Map();
    return [...modules]
      .filter(([, module]) => closure.has(module.path))
      .map(([sourceConfigPath, buildModule]) => ({
        buildModule,
        checker,
        sourceConfigPath,
        outputDeclarationCopyContexts: getOutputDeclarationCopyContexts({
          checkerName: checker.name,
          generatedGraph: graph,
          sourceConfigPath,
        }),
      }));
  });
}

export async function copySuccessfulBuildTarget(
  options: CopyInput,
  target: TypecheckTarget,
): Promise<AuthorizedResult<string | null>> {
  try {
    const result = await copyTarget(options, target);
    assertCopyCompleted(result);
    return result;
  } catch (error) {
    return {
      state: 'refused',
      rejection: {
        status: 'admission-rejected',
        id: target.id,
        stage: 'output-copy',
        decision: 'unavailable',
        diagnostics: [
          {
            code: 'LIMINA_EXECUTION_INPUT_UNAVAILABLE',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    };
  }
}
async function copyTarget(
  options: CopyInput,
  target: TypecheckTarget,
): Promise<AuthorizedResult<string | null>> {
  let descriptors: BuildTargetDescriptor[];
  let workspace: Awaited<
    ReturnType<LiminaPreflightManager['ensureWorkspaceValidated']>
  >;
  let prepared: ReturnType<typeof createCopyPlan>;
  return options.admission.withManagedWrites(
    target,
    async () => {
      descriptors = coveredOutputDescriptors(options.admission.graph, target);
      workspace = await options.preflight.ensureWorkspaceValidated();
      prepared = createCopyPlan({
        contexts: collectOutputDeclarationCopyContexts(descriptors),
        projectRootDir: options.projectRootDir,
        workspaceContext: workspace,
      });
      return new Set(prepared.entries.map((entry) => entry.targetPath));
    },
    async (recordWrites) => {
      let copied: AuthorizedResult<string | null> = {
        state: 'executed',
        value: null,
      };
      const value = await runOutputDeclarationCopyPostBuild({
        buildTargetDescriptors: descriptors,
        flow: options.request.flow,
        flowDepth: options.flowDepth,
        projectRootDir: options.projectRootDir,
        report: options.request.report,
        workspaceContext: workspace,
        authorizeCopy: async (plan, action) => {
          if (JSON.stringify(prepared) !== JSON.stringify(plan))
            throw new Error(
              'Declaration copy plan changed during preparation.',
            );
          copied = await options.admission.withAuthorizedTarget(
            target,
            { stage: 'output-copy', authority: plan },
            async (permit) => {
              await options.admission.assertPermit(permit, target, {
                stage: 'output-copy',
                authority: plan,
              });
              recordWrites();
              return action();
            },
          );
          return copied.state === 'executed' ? copied.value : null;
        },
      });
      return completedCopy(copied, value);
    },
  );
}

function completedCopy(
  copied: AuthorizedResult<string | null>,
  value: string | null,
): AuthorizedResult<string | null> {
  return copied.state === 'refused' ? copied : { state: 'executed', value };
}

function assertCopyCompleted(result: AuthorizedResult<string | null>): void {
  if (result.state === 'executed' && result.value !== null)
    throw new Error(result.value);
}
