import { getCheckerExtensions } from '#checkers';
import type { BuildCheckerPreset, ResolvedCheckerConfig } from '#config/runner';
import type {
  GeneratedBuildModule,
  GeneratedOutputDeclarationCopyContext,
  GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import { isOrdinarySourceTypecheckConfigPath } from '#core/tsconfig/actions';

export interface BuildTargetDescriptor {
  buildModule: GeneratedBuildModule;
  checker: ResolvedCheckerConfig;
  outputDeclarationCopyContexts?: GeneratedOutputDeclarationCopyContext[];
  sourceConfigPath: string;
}

export type ManagedDeclarationBuildTarget = BuildTargetDescriptor;

export function getBuildTargetDescriptorKey(
  descriptor: BuildTargetDescriptor,
): string {
  return `${descriptor.checker.name}\0${descriptor.sourceConfigPath}`;
}

export function createRawBuildChecker(options: {
  preset: BuildCheckerPreset;
  projectRootDir: string;
}): ResolvedCheckerConfig {
  return {
    exclude: [],
    extensions: getCheckerExtensions(
      { include: [], preset: options.preset },
      { projectRootDir: options.projectRootDir },
    ),
    include: [],
    name: options.preset,
    preset: options.preset,
  };
}

export function collectManagedDeclarationBuildTargets(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): BuildTargetDescriptor[] {
  return options.allCheckers.flatMap((checker) => {
    const buildModule = options.generatedGraph.sourceToBuild
      .get(checker.name)
      ?.get(options.sourceConfigPath);
    if (buildModule === undefined) return [];
    return [
      {
        buildModule,
        checker,
        sourceConfigPath: options.sourceConfigPath,
      },
    ];
  });
}

function cloneCopyContexts(
  contexts: readonly GeneratedOutputDeclarationCopyContext[] | undefined,
): GeneratedOutputDeclarationCopyContext[] | undefined {
  if (contexts === undefined) return undefined;
  if (contexts.length === 0) return undefined;
  return contexts.map((context) => ({ ...context }));
}

export function getOutputDeclarationCopyContexts(options: {
  checkerName: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): GeneratedOutputDeclarationCopyContext[] | undefined {
  return cloneCopyContexts(
    options.generatedGraph.outputDeclarationCopies
      .get(options.checkerName)
      ?.get(options.sourceConfigPath),
  );
}

function collectManagedOutputBuildTargets(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): BuildTargetDescriptor[] {
  return options.allCheckers.flatMap((checker) => {
    const buildModule = options.generatedGraph.configToOutputBuild
      .get(checker.name)
      ?.get(options.sourceConfigPath);
    if (buildModule === undefined) return [];
    return [
      {
        buildModule,
        checker,
        outputDeclarationCopyContexts: getOutputDeclarationCopyContexts({
          checkerName: checker.name,
          generatedGraph: options.generatedGraph,
          sourceConfigPath: options.sourceConfigPath,
        }),
        sourceConfigPath: options.sourceConfigPath,
      },
    ];
  });
}

export function getManagedBuildTargets(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): {
  declarationTargets: BuildTargetDescriptor[];
  outputTargets: BuildTargetDescriptor[];
} {
  if (!isOrdinarySourceTypecheckConfigPath(options.sourceConfigPath)) {
    return { declarationTargets: [], outputTargets: [] };
  }
  return {
    declarationTargets: collectManagedDeclarationBuildTargets(options),
    outputTargets: collectManagedOutputBuildTargets(options),
  };
}
