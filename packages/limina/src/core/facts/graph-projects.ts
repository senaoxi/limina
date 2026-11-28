import type { AnalysisProviderSet } from '#core';
import { FileOwnerLookup } from '../build-graph/file-owner-lookup';
import type { GeneratedTsconfigGraphResult } from '../build-graph/types';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { ProjectInfo } from '../import-graph/project-types';
import { createParsedProjectSemanticContext } from '../project-dependencies/context';
import type { ProjectDependencyCollection } from '../project-dependencies/contracts';
import { createUnitByProjectPath } from '../project-dependencies/project-alignment';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic';
import type { WorkspaceLookupIndex } from '../workspace/lookup';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { prepareRuntimeProjectFacts } from './governance';
import { planRuleSubscriptions } from './subscription';

export interface PreparedGraphProjectDependencies {
  readonly declaration: ProjectDependencyCollection;
  readonly project: ProjectInfo;
  readonly runtime: ProjectDependencyCollection;
}

export type PreparedDependencyGraphProject =
  | ProjectDependencyCollection
  | string;

function requireGraphAuthority(project: ProjectInfo) {
  const authority = project.semanticAuthority;
  if (authority !== undefined) return authority;
  throw new Error(
    `Missing frozen semantic authority for graph-check project ${project.configPath}.`,
  );
}

function assertGraphCollection(collection: ProjectDependencyCollection): void {
  const failure = collection.failures[0];
  if (failure === undefined) return;
  throw new Error(
    `Graph-check semantic dependency collection failed at ${failure.stage}: ${failure.reason}`,
  );
}

export async function prepareGraphProjectDependencies(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  managedOutputLookup: ManagedOutputDeclarationLookup;
  projects: readonly ProjectInfo[];
  providers: AnalysisProviderSet;
  rootDir: string;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<readonly PreparedGraphProjectDependencies[]> {
  const { generatedGraph, projects, providers, workspaceLookup } = options;
  const view = providers.facts.createSubscribedView(
    planRuleSubscriptions(['graph:reference-completeness']),
  );
  const unitByProjectPath = createUnitByProjectPath(generatedGraph);
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    projects,
    {
      membership: new FileOwnerLookup(projects),
      isWorkspaceFile: (file) =>
        workspaceLookup.findOwnerForFile(file) !== null,
    },
    generatedGraph.sourceConfigCoverage,
  );
  const prepared: PreparedGraphProjectDependencies[] = [];
  for (const project of projects) {
    const owner = workspaceLookup.findOwnerForFile(project.configPath);
    const packageRootDirectory = owner?.directory ?? options.rootDir;
    const declaration = providers.facts.prepareSemanticProjectDependencies({
      compilationObligationScope: 'generated-declaration-project-v1',
      context: createParsedProjectSemanticContext({
        authority: requireGraphAuthority(project),
        packageRootDir: packageRootDirectory,
        project,
        workspaceSourceBoundary,
      }),
      importAnalysis: providers.imports.context,
      managedOutputLookup: options.managedOutputLookup,
    });
    assertGraphCollection(declaration);
    const runtime = await prepareRuntimeProjectFacts({
      view,
      packageRootDir: packageRootDirectory,
      project,
      providers,
      unit: unitByProjectPath.get(project.configPath),
      workspaceSourceBoundary,
    });
    assertGraphCollection(runtime);
    prepared.push({ declaration, project, runtime });
  }
  return prepared;
}

export async function prepareDependencyGraphProjects(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  pathIndex: WorkspaceRegionPathIndex;
  projects: readonly ProjectInfo[];
  providers: AnalysisProviderSet;
  rootDir: string;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<readonly PreparedDependencyGraphProject[]> {
  const { pathIndex, projects, providers, workspaceLookup } = options;
  const view = providers.facts.createSubscribedView(
    planRuleSubscriptions(['dependency-graph:export']),
  );
  const unitByProjectPath = createUnitByProjectPath(options.generatedGraph);
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    projects,
    {
      membership: new FileOwnerLookup(projects),
      isWorkspaceFile: (file) => pathIndex.findPackageForPath(file) !== null,
    },
  );
  const prepared: PreparedDependencyGraphProject[] = [];
  for (const project of projects) {
    if (project.semanticAuthority === undefined) {
      prepared.push(
        `Missing frozen semantic authority for dependency graph project ${project.configPath}.`,
      );
      continue;
    }
    const owner = workspaceLookup.findPackageForFile(project.configPath);
    prepared.push(
      await prepareRuntimeProjectFacts({
        view,
        packageRootDir: owner?.directory ?? options.rootDir,
        project,
        providers,
        unit: unitByProjectPath.get(project.configPath),
        workspaceSourceBoundary,
      }),
    );
  }
  return prepared;
}
