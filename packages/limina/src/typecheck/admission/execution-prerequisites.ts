import type {
  GeneratedDependencyEdge,
  GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import {
  collectOutputDeclarationCopyContexts,
  createCopyPlan,
} from '../build/output-copy';
import type { executeCheckerBuildTargets } from '../checker/build-execution';
import { coveredOutputDescriptors } from '../managed-build-copy';
import { ManagedCheckerMutationCoordinator } from '../managed/coordinator';
import type { TypecheckTarget } from '../targets';
import type { ExecutionAdmission } from './execution-admission';
import { missingExecutionInputs } from './missing-execution-inputs';

type BuildOptions = Parameters<typeof executeCheckerBuildTargets>[0];
type Outputs = ReadonlyMap<TypecheckTarget, ReadonlySet<string>>;
export interface ProducerPreparation {
  graph: GeneratedTsconfigGraphResult;
  coordinator: ManagedCheckerMutationCoordinator;
}
interface ProducerProof {
  outputs: ReadonlySet<string>;
  preparation: ProducerPreparation;
}
interface ExecutionPrerequisites {
  dependencies: GeneratedDependencyEdge[];
  preparations: ReadonlyMap<TypecheckTarget, ProducerPreparation>;
}
async function proveProducer(
  options: BuildOptions,
  admission: ExecutionAdmission,
  target: TypecheckTarget,
): Promise<ProducerProof> {
  return admission.withTargetEvidence(target, async () => {
    const graph = admission.graph;
    const coordinator = await ManagedCheckerMutationCoordinator.create({
      artifactNamespace: options.preflight.artifactNamespace,
      checkers: options.allCheckers,
      config: options.config,
      generatedGraph: graph,
      targets: [target],
      workspaceContext: options.workspaceContext,
    });
    const copies = createCopyPlan({
      contexts: collectOutputDeclarationCopyContexts(
        coveredOutputDescriptors(graph, target),
      ),
      projectRootDir: options.projectRootDir,
      workspaceContext: options.workspaceContext,
    });
    if (copies.problems.some((problem) => problem.severity === 'error'))
      throw new Error('Producer copy mapping is unavailable.');
    return {
      preparation: { graph, coordinator },
      outputs: new Set([
        ...coordinator.projectedOutputPaths(target),
        ...copies.entries.map((entry) => entry.targetPath),
      ]),
    };
  });
}
async function producerOutputs(
  options: BuildOptions,
  admission: ExecutionAdmission,
): Promise<Map<TypecheckTarget, ProducerProof>> {
  const outputs = new Map<TypecheckTarget, ProducerProof>();
  for (const target of options.targets) {
    const proof = await optionalProducerProof(options, admission, target);
    if (proof !== undefined) outputs.set(target, proof);
  }
  return outputs;
}
async function optionalProducerProof(
  options: BuildOptions,
  admission: ExecutionAdmission,
  target: TypecheckTarget,
): Promise<ProducerProof | undefined> {
  try {
    return await proveProducer(options, admission, target);
  } catch {
    return undefined;
  }
}
function prerequisite(
  consumer: TypecheckTarget,
  provider: TypecheckTarget,
  file: string,
): GeneratedDependencyEdge & {
  consumerTargetId: string;
  providerTargetId: string;
} {
  return {
    kind: 'declaration-provider',
    cacheReuse: 'non-reusable',
    fromChecker: consumer.checkerName!,
    fromConfigPath: consumer.sourceConfigPath ?? consumer.configPath,
    toChecker: provider.checkerName!,
    toConfigPath: provider.sourceConfigPath ?? provider.configPath,
    file,
    importedSpecifier: file,
    resolvedFilePath: file,
    consumerTargetId: consumer.id,
    providerTargetId: provider.id,
  };
}
function requestPrerequisite(
  outputs: Outputs,
  consumer: TypecheckTarget,
  missing: ReadonlySet<string>,
): GeneratedDependencyEdge[] {
  if (canSupplyOwnInput(outputs, consumer, missing)) return [];
  const providers = [...outputs].filter(
    ([target, files]) => target !== consumer && !files.isDisjointFrom(missing),
  );
  if (providers.length !== 1) return [];
  const [provider, files] = providers[0]!;
  return [
    prerequisite(consumer, provider, [...files.intersection(missing)][0]!),
  ];
}
async function consumerPrerequisites(
  admission: ExecutionAdmission,
  outputs: Outputs,
  consumer: TypecheckTarget,
): Promise<GeneratedDependencyEdge[]> {
  try {
    return await admission.withManagedWrites(consumer, new Set(), async () =>
      missingExecutionInputs(admission, consumer).flatMap((missing) =>
        requestPrerequisite(outputs, consumer, missing),
      ),
    );
  } catch {
    return [];
  }
}
/**
Only missing inputs, actual capabilities and selected producers establish hard dependencies; ordering never does.
*/
export function proveExecutionPrerequisites(
  options: BuildOptions,
  admission: ExecutionAdmission,
): Promise<ExecutionPrerequisites> {
  return admission.withReadOnlyValidation(() =>
    collectPrerequisites(options, admission),
  );
}
async function collectPrerequisites(
  options: BuildOptions,
  admission: ExecutionAdmission,
): Promise<ExecutionPrerequisites> {
  const producers = await producerOutputs(options, admission);
  const outputs: Outputs = new Map(
    [...producers].map(([target, proof]) => [target, proof.outputs]),
  );
  const prerequisites: GeneratedDependencyEdge[] = [];
  for (const consumer of options.targets)
    prerequisites.push(
      ...(await consumerPrerequisites(admission, outputs, consumer)),
    );
  return {
    dependencies: prerequisites,
    preparations: new Map(
      [...producers].map(([target, proof]) => [target, proof.preparation]),
    ),
  };
}

function canSupplyOwnInput(
  outputs: Outputs,
  consumer: TypecheckTarget,
  missing: ReadonlySet<string>,
): boolean {
  return outputs.get(consumer)?.isDisjointFrom(missing) === false;
}
