import type { ResolvedLiminaConfig, VueImportParser } from '#config/runner';
import {
  createFileOwnerLookup,
  createImportAnalysisContext,
} from '#core/import-graph/context';
import { compareCodeUnits } from '#utils/collections';
import { createManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { addImplicitProjectReferences } from './implicit-references';
import {
  createDtsProjectsBySourcePath,
  createManagedOutputProjectContexts,
} from './project-indexes';
import {
  processProjectReferenceImports,
  type ReferenceImportContext,
} from './reference-imports';
import type {
  GeneratedProviderEdge,
  InferredProjectReferenceCollection,
  PrepareGeneratedTsconfigGraphOptions,
  SourceProject,
} from './types';

function getVueParser(
  config: ResolvedLiminaConfig,
): VueImportParser | undefined {
  if (!config.config) {
    return undefined;
  }
  return config.config.imports ? config.config.imports.vue : undefined;
}

function createImportAnalysis(options: {
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
}) {
  if (options.importAnalysisContext) {
    return options.importAnalysisContext;
  }
  return createImportAnalysisContext({
    projectRootDir: options.config.rootDir,
    vueParser: getVueParser(options.config),
  });
}

function createOwnerLookup(projects: SourceProject[]): Map<string, string[]> {
  return createFileOwnerLookup(
    projects.map((project) => ({
      checkerPresets: project.context.checkerPresets,
      configPath: project.configPath,
      extensions: project.context.extensions,
      fileNames: project.ownedFileNames,
      labels: project.graphRules,
      labelProblem: null,
      ownedFileNames: project.ownedFileNames,
      options: project.options,
      references: project.references,
      resolverConfigPath: project.configPath,
    })),
  );
}

function compareProviderEdges(
  left: GeneratedProviderEdge,
  right: GeneratedProviderEdge,
): number {
  const comparisons = [
    compareCodeUnits(left.fromChecker, right.fromChecker),
    compareCodeUnits(left.fromConfigPath, right.fromConfigPath),
    compareCodeUnits(left.toChecker, right.toChecker),
    compareCodeUnits(left.toConfigPath, right.toConfigPath),
    compareCodeUnits(left.file, right.file),
    compareCodeUnits(left.importedSpecifier, right.importedSpecifier),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

function addImplicitReferences(options: {
  config: ResolvedLiminaConfig;
  localDtsProjectsBySourcePath: Map<string, SourceProject[]>;
  problems: string[];
  projects: SourceProject[];
}): void {
  for (const project of options.projects) {
    addImplicitProjectReferences({
      config: options.config,
      localDtsProjectsBySourcePath: options.localDtsProjectsBySourcePath,
      problems: options.problems,
      project,
    });
  }
}

function processReferenceImports(options: {
  context: ReferenceImportContext;
  projects: SourceProject[];
}): void {
  for (const project of options.projects) {
    processProjectReferenceImports({ context: options.context, project });
  }
}

export function inferProjectReferences(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  ownerProjects?: SourceProject[];
  projects: SourceProject[];
}): InferredProjectReferenceCollection {
  const ownerProjects = options.ownerProjects ?? options.projects;
  const problems: string[] = [];
  const providerEdgesByKey = new Map<string, GeneratedProviderEdge>();
  const localDtsProjectsBySourcePath = createDtsProjectsBySourcePath(
    options.projects,
  );
  addImplicitReferences({
    config: options.config,
    localDtsProjectsBySourcePath,
    problems,
    projects: options.projects,
  });
  const context: ReferenceImportContext = {
    activatedRegions: options.activatedRegions,
    config: options.config,
    dtsProjectsBySourcePath: createDtsProjectsBySourcePath(ownerProjects),
    fileOwnerLookup: createOwnerLookup(ownerProjects),
    importAnalysis: createImportAnalysis(options),
    managedOutputLookup: createManagedOutputDeclarationLookup(
      createManagedOutputProjectContexts(ownerProjects),
    ),
    problems,
    providerEdgesByKey,
  };
  processReferenceImports({ context, projects: options.projects });
  return {
    problems,
    providerEdges: [...providerEdgesByKey.values()].sort(compareProviderEdges),
  };
}
