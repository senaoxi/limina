import { getCheckerAdapter } from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { compareCodeUnits } from '#utils/collections';
import {
  type BuildTargetDescriptor,
  getBuildTargetDescriptorKey,
  getOutputDeclarationCopyContexts,
} from './target-resolution';

function isBuildCapableChecker(checker: ResolvedCheckerConfig): boolean {
  const adapter = getCheckerAdapter(checker.preset);
  if (adapter === null) return false;
  return adapter.execution === 'build';
}

function getBuildCapableChecker(options: {
  checkerByName: ReadonlyMap<string, ResolvedCheckerConfig>;
  checkerName: string;
}): ResolvedCheckerConfig | null {
  const checker = options.checkerByName.get(options.checkerName);
  if (checker === undefined) return null;
  return isBuildCapableChecker(checker) ? checker : null;
}

function getProviderBuildModule(options: {
  checker: ResolvedCheckerConfig;
  edge: GeneratedTsconfigGraphResult['providerEdges'][number];
  generatedGraph: GeneratedTsconfigGraphResult;
}) {
  return options.generatedGraph.configToOutputBuild
    .get(options.checker.name)
    ?.get(options.edge.toConfigPath);
}

function createProviderDescriptor(options: {
  checkerByName: ReadonlyMap<string, ResolvedCheckerConfig>;
  edge: GeneratedTsconfigGraphResult['providerEdges'][number];
  generatedGraph: GeneratedTsconfigGraphResult;
}): BuildTargetDescriptor | null {
  const checker = getBuildCapableChecker({
    checkerByName: options.checkerByName,
    checkerName: options.edge.toChecker,
  });
  if (checker === null) return null;
  const buildModule = getProviderBuildModule({ ...options, checker });
  if (buildModule === undefined) return null;
  return {
    buildModule,
    checker,
    outputDeclarationCopyContexts: getOutputDeclarationCopyContexts({
      checkerName: checker.name,
      generatedGraph: options.generatedGraph,
      sourceConfigPath: options.edge.toConfigPath,
    }),
    sourceConfigPath: options.edge.toConfigPath,
  };
}

function edgeStartsAtDescriptor(options: {
  descriptor: BuildTargetDescriptor;
  edge: GeneratedTsconfigGraphResult['providerEdges'][number];
}): boolean {
  if (options.edge.fromChecker !== options.descriptor.checker.name)
    return false;
  return options.edge.fromConfigPath === options.descriptor.sourceConfigPath;
}

function getProviderDescriptors(options: {
  checkerByName: ReadonlyMap<string, ResolvedCheckerConfig>;
  descriptor: BuildTargetDescriptor;
  generatedGraph: GeneratedTsconfigGraphResult;
}): BuildTargetDescriptor[] {
  return options.generatedGraph.providerEdges
    .filter((edge) =>
      edgeStartsAtDescriptor({ descriptor: options.descriptor, edge }),
    )
    .flatMap((edge) => {
      const descriptor = createProviderDescriptor({ ...options, edge });
      return descriptor === null ? [] : [descriptor];
    });
}

function compareDescriptors(
  left: BuildTargetDescriptor,
  right: BuildTargetDescriptor,
): number {
  const checkerOrder = compareCodeUnits(left.checker.name, right.checker.name);
  if (checkerOrder !== 0) return checkerOrder;
  return compareCodeUnits(left.sourceConfigPath, right.sourceConfigPath);
}

function seedDescriptorMap(
  initialTargets: readonly BuildTargetDescriptor[],
): Map<string, BuildTargetDescriptor> {
  return new Map(
    initialTargets.map((target) => [
      getBuildTargetDescriptorKey(target),
      target,
    ]),
  );
}

function appendNewDescriptors(options: {
  descriptors: readonly BuildTargetDescriptor[];
  descriptorsByKey: Map<string, BuildTargetDescriptor>;
  queue: BuildTargetDescriptor[];
}): void {
  for (const descriptor of options.descriptors) {
    const key = getBuildTargetDescriptorKey(descriptor);
    if (options.descriptorsByKey.has(key)) continue;
    options.descriptorsByKey.set(key, descriptor);
    options.queue.push(descriptor);
  }
}

function expandDescriptor(options: {
  checkerByName: ReadonlyMap<string, ResolvedCheckerConfig>;
  descriptor: BuildTargetDescriptor;
  descriptorsByKey: Map<string, BuildTargetDescriptor>;
  generatedGraph: GeneratedTsconfigGraphResult;
  queue: BuildTargetDescriptor[];
}): void {
  appendNewDescriptors({
    descriptors: getProviderDescriptors(options),
    descriptorsByKey: options.descriptorsByKey,
    queue: options.queue,
  });
}

export function collectBuildTargetProviderClosure(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  initialTargets: readonly BuildTargetDescriptor[];
}): BuildTargetDescriptor[] {
  const checkerByName = new Map(
    options.allCheckers.map((checker) => [checker.name, checker]),
  );
  const descriptorsByKey = seedDescriptorMap(options.initialTargets);
  const queue = [...options.initialTargets];
  let current = queue.shift();
  while (current !== undefined) {
    expandDescriptor({
      checkerByName,
      descriptor: current,
      descriptorsByKey,
      generatedGraph: options.generatedGraph,
      queue,
    });
    current = queue.shift();
  }
  return [...descriptorsByKey.values()].sort(compareDescriptors);
}
