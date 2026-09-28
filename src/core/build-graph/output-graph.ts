import { getCheckerAdapter } from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { createOutputProjectBuildModule } from './build-modules';
import {
  addOutputSolution,
  createOutputDeclarationCopyContext,
} from './output-solutions';
import type {
  CheckerOutputGraph,
  CheckerSourceConfigCollection,
  GeneratedBuildModule,
  GeneratedOutputDeclarationCopyContext,
  OutputSolutionProject,
  SourceProject,
} from './types';

function createEmptyOutputGraph(): CheckerOutputGraph {
  return {
    configToOutputBuild: new Map(),
    outputDeclarationCopies: new Map(),
    outputProjects: [],
    outputSolutions: [],
  };
}

function isBuildChecker(checker: ResolvedCheckerConfig): boolean {
  const adapter = getCheckerAdapter(checker.name);
  return adapter ? adapter.execution === 'build' : false;
}

function formatMissingOutputDependencyProblem(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
  targetProject: SourceProject;
}): string {
  return [
    'Missing Limina output options for referenced source project:',
    `  config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  referenced config: ${toRelativePath(options.config.rootDir, options.targetProject.configPath)}`,
    '  reason: this output-enabled source project has a Limina-generated project reference to another managed source project that does not declare liminaOptions.outputs.',
    '  fix: add liminaOptions.outputs to the referenced source config, or move the dependency behind a declaration or artifact boundary.',
  ].join('\n');
}

function addOutputProjectReference(options: {
  allProjectsByDtsPath: Map<string, SourceProject>;
  config: ResolvedLiminaConfig;
  problems: string[];
  project: SourceProject;
  referencePath: string;
}): void {
  const targetProject = options.allProjectsByDtsPath.get(options.referencePath);
  if (!targetProject) {
    return;
  }
  if (!targetProject.outputOptions) {
    options.problems.push(
      formatMissingOutputDependencyProblem({
        config: options.config,
        project: options.project,
        targetProject,
      }),
    );
    return;
  }
  options.project.outputReferences.add(targetProject.outputConfigPath);
}

function addOutputProjectReferences(options: {
  allProjectsByDtsPath: Map<string, SourceProject>;
  config: ResolvedLiminaConfig;
  problems: string[];
  project: SourceProject;
}): void {
  for (const referencePath of options.project.references) {
    addOutputProjectReference({ ...options, referencePath });
  }
}

function createOutputProjectModules(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  outputProjects: SourceProject[];
}): Map<string, GeneratedBuildModule> {
  return new Map(
    options.outputProjects.map((project) => [
      project.configPath,
      createOutputProjectBuildModule({
        checkerName: options.checkerName,
        packageRootDir: project.packageRootDir,
        rootDir: options.config.rootDir,
        sourceConfigPath: project.configPath,
      }),
    ]),
  );
}

function createOutputProjectCopies(
  outputProjects: SourceProject[],
): Map<string, GeneratedOutputDeclarationCopyContext[]> {
  const copies = new Map<string, GeneratedOutputDeclarationCopyContext[]>();
  for (const project of outputProjects) {
    const copyContext = createOutputDeclarationCopyContext(project);
    if (copyContext) {
      copies.set(project.configPath, [copyContext]);
    }
  }
  return copies;
}

interface OutputGraphState {
  configToOutputBuild: Map<string, GeneratedBuildModule>;
  outputDeclarationCopies: Map<string, GeneratedOutputDeclarationCopyContext[]>;
  outputProjectByOutputConfigPath: Map<string, SourceProject>;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  outputProjects: SourceProject[];
  outputSolutions: OutputSolutionProject[];
}

function createOutputGraphState(options: {
  checker: ResolvedCheckerConfig;
  config: ResolvedLiminaConfig;
  projects: SourceProject[];
}): OutputGraphState {
  const outputProjects = options.projects.filter((project) =>
    Boolean(project.outputOptions),
  );
  const outputProjectModuleBySourcePath = createOutputProjectModules({
    checkerName: options.checker.name,
    config: options.config,
    outputProjects,
  });
  return {
    configToOutputBuild: new Map(outputProjectModuleBySourcePath),
    outputDeclarationCopies: createOutputProjectCopies(outputProjects),
    outputProjectByOutputConfigPath: new Map(
      outputProjects.map((project) => [project.outputConfigPath, project]),
    ),
    outputProjectModuleBySourcePath,
    outputProjects,
    outputSolutions: [],
  };
}

function addAllOutputProjectReferences(options: {
  allProjectsByDtsPath: Map<string, SourceProject>;
  config: ResolvedLiminaConfig;
  outputProjects: SourceProject[];
  problems: string[];
}): void {
  for (const project of options.outputProjects) {
    addOutputProjectReferences({ ...options, project });
  }
}

function addAllOutputSolutions(options: {
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  state: OutputGraphState;
}): void {
  const sourceConfigPaths = [...options.collection.solutionConfigPaths].sort(
    compareCodeUnits,
  );
  for (const sourceConfigPath of sourceConfigPaths) {
    addOutputSolution({
      checker: options.checker,
      collection: options.collection,
      config: options.config,
      configToOutputBuild: options.state.configToOutputBuild,
      outputDeclarationCopies: options.state.outputDeclarationCopies,
      outputProjectByOutputConfigPath:
        options.state.outputProjectByOutputConfigPath,
      outputProjectModuleBySourcePath:
        options.state.outputProjectModuleBySourcePath,
      outputSolutions: options.state.outputSolutions,
      sourceConfigPath,
    });
  }
}

export function createCheckerOutputGraph(options: {
  allProjectsByDtsPath: Map<string, SourceProject>;
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProject[];
}): CheckerOutputGraph {
  if (!isBuildChecker(options.checker)) {
    return createEmptyOutputGraph();
  }
  const state = createOutputGraphState(options);
  addAllOutputProjectReferences({
    allProjectsByDtsPath: options.allProjectsByDtsPath,
    config: options.config,
    outputProjects: state.outputProjects,
    problems: options.problems,
  });
  addAllOutputSolutions({
    checker: options.checker,
    collection: options.collection,
    config: options.config,
    state,
  });
  return {
    configToOutputBuild: state.configToOutputBuild,
    outputDeclarationCopies: state.outputDeclarationCopies,
    outputProjects: state.outputProjects,
    outputSolutions: state.outputSolutions,
  };
}
