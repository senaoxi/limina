import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { createOutputSolutionBuildModule } from './build-modules';
import { getGeneratedOutputSolutionConfigPath } from './generated/paths';
import type {
  CheckerSourceConfigCollection,
  GeneratedBuildModule,
  GeneratedOutputDeclarationCopyContext,
  OutputSolutionProject,
  SourceProject,
} from './types';

export function createOutputDeclarationCopyContext(
  project: SourceProject,
): GeneratedOutputDeclarationCopyContext | null {
  if (!project.outputOptions) {
    return null;
  }
  return {
    fileNames: [...project.fileNames],
    outDir: project.outputOptions.outDir,
    rootDir: project.outputOptions.rootDir,
    sourceConfigPath: project.configPath,
  };
}

function createOutputSolutionProject(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  packageRootDir: string;
  references: string[];
  sourceConfigPath: string;
}): OutputSolutionProject {
  return {
    buildConfigPath: getGeneratedOutputSolutionConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    packageRootDir: options.packageRootDir,
    references: new Set(options.references),
  };
}

function addNestedReferences(options: {
  collection: CheckerSourceConfigCollection;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  outputReferences: Set<string>;
  referencePath: string;
  seenConfigPaths: Set<string>;
}): void {
  const nestedReferences = collectFlattenedOutputSolutionReferences({
    collection: options.collection,
    outputProjectModuleBySourcePath: options.outputProjectModuleBySourcePath,
    seenConfigPaths: options.seenConfigPaths,
    sourceConfigPath: options.referencePath,
  });
  for (const nestedReference of nestedReferences) {
    options.outputReferences.add(nestedReference);
  }
}

function collectOutputReference(options: {
  collection: CheckerSourceConfigCollection;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  outputReferences: Set<string>;
  referencePath: string;
  seenConfigPaths: Set<string>;
}): void {
  const outputProjectModule = options.outputProjectModuleBySourcePath.get(
    options.referencePath,
  );
  if (outputProjectModule) {
    options.outputReferences.add(outputProjectModule.path);
    return;
  }
  addNestedReferences(options);
}

function getSeenConfigPaths(
  seenConfigPaths: Set<string> | undefined,
): Set<string> {
  return seenConfigPaths ?? new Set<string>();
}

function getSolutionReferences(options: {
  collection: CheckerSourceConfigCollection;
  sourceConfigPath: string;
}): string[] {
  return (
    options.collection.solutionReferencesBySourcePath.get(
      options.sourceConfigPath,
    ) ?? []
  );
}

export function collectFlattenedOutputSolutionReferences(options: {
  collection: CheckerSourceConfigCollection;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  sourceConfigPath: string;
  seenConfigPaths?: Set<string>;
}): string[] {
  const seenConfigPaths = getSeenConfigPaths(options.seenConfigPaths);
  if (seenConfigPaths.has(options.sourceConfigPath)) {
    return [];
  }
  seenConfigPaths.add(options.sourceConfigPath);
  const outputReferences = new Set<string>();
  for (const referencePath of getSolutionReferences(options)) {
    collectOutputReference({
      collection: options.collection,
      outputProjectModuleBySourcePath: options.outputProjectModuleBySourcePath,
      outputReferences,
      referencePath,
      seenConfigPaths,
    });
  }
  return [...outputReferences].sort(compareCodeUnits);
}

function createSolutionCopyContexts(options: {
  outputProjectByOutputConfigPath: ReadonlyMap<string, SourceProject>;
  references: readonly string[];
}): GeneratedOutputDeclarationCopyContext[] {
  return options.references
    .map((referencePath) =>
      options.outputProjectByOutputConfigPath.get(referencePath),
    )
    .filter((project): project is SourceProject => Boolean(project))
    .map(createOutputDeclarationCopyContext)
    .filter(
      (copyContext): copyContext is GeneratedOutputDeclarationCopyContext =>
        Boolean(copyContext),
    )
    .sort((left, right) =>
      compareCodeUnits(left.sourceConfigPath, right.sourceConfigPath),
    );
}

export function addOutputSolution(options: {
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  configToOutputBuild: Map<string, GeneratedBuildModule>;
  outputDeclarationCopies: Map<string, GeneratedOutputDeclarationCopyContext[]>;
  outputProjectByOutputConfigPath: ReadonlyMap<string, SourceProject>;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  outputSolutions: OutputSolutionProject[];
  sourceConfigPath: string;
}): void {
  const references = collectFlattenedOutputSolutionReferences({
    collection: options.collection,
    outputProjectModuleBySourcePath: options.outputProjectModuleBySourcePath,
    sourceConfigPath: options.sourceConfigPath,
  });
  if (references.length === 0) {
    return;
  }
  const packageRootDir = options.collection.packageRootBySourcePath.get(
    options.sourceConfigPath,
  )!;
  const outputSolution = createOutputSolutionProject({
    checkerName: options.checker.name,
    config: options.config,
    packageRootDir,
    references,
    sourceConfigPath: options.sourceConfigPath,
  });
  options.outputSolutions.push(outputSolution);
  options.configToOutputBuild.set(
    options.sourceConfigPath,
    createOutputSolutionBuildModule({
      checkerName: options.checker.name,
      packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
  );
  options.outputDeclarationCopies.set(
    options.sourceConfigPath,
    createSolutionCopyContexts({
      outputProjectByOutputConfigPath: options.outputProjectByOutputConfigPath,
      references,
    }),
  );
}
