import type { AnalysisProviderSet } from '#core';
import { compareCodeUnits } from '#utils/collections';
import { FileOwnerLookup } from '../build-graph/file-owner-lookup';
import type { GeneratedTsconfigGraphResult } from '../build-graph/types';
import type { ProjectDependencyCollection } from '../project-dependencies/contracts';
import { createUnitByProjectPath } from '../project-dependencies/project-alignment';
import type { CollectSourceGraphProjectExtensionsResult } from '../tsconfig/actions';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic';
import type { WorkspaceLookupIndex } from '../workspace/lookup';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { prepareRuntimeProjectFacts } from './governance';
import { ResourceFactCollector, type ResourceProjectFacts } from './resource';
import {
  createSourceProjectEntries,
  type SourceProjectEntry,
} from './source-entries';
import { planRuleSubscriptions } from './subscription';

export interface SourceProjectFacts {
  readonly runtime: ProjectDependencyCollection;
  readonly resources: ResourceProjectFacts;
}

export interface SourceGovernanceFacts {
  readonly entries: SourceProjectEntry[];
  readonly projectFacts: ReadonlyMap<string, SourceProjectFacts>;
}

export async function prepareSourceProjectFacts(options: {
  providers: AnalysisProviderSet;
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRoute: CollectSourceGraphProjectExtensionsResult;
  workspaceLookup: WorkspaceLookupIndex;
  pathIndex: WorkspaceRegionPathIndex;
  rootDir: string;
}): Promise<SourceGovernanceFacts> {
  const { providers, graphRoute, workspaceLookup } = options;
  providers.facts.requireProduct('resource');
  const entries = await createSourceProjectEntries({
    generatedGraph: options.generatedGraph,
    providers,
    workspaceLookup,
    projectPaths: graphRoute.projectExtensionsByPath
      .keys()
      .toArray()
      .sort(compareCodeUnits),
    projectContextsByPath: graphRoute.projectContextsByPath,
  });
  const workspaceSourceBoundary = providers.facts.hasWorkspaceSourceBoundary()
    ? providers.facts.getWorkspaceSourceBoundary()
    : createWorkspaceSourceBoundaryFromProjects(entries, {
        membership: new FileOwnerLookup(entries.map((entry) => entry.project)),
        isWorkspaceFile: (file) =>
          options.pathIndex.findPackageForPath(file) !== null,
      });
  const view = providers.facts.createSubscribedView(
    planRuleSubscriptions(['source:import-authority']),
  );
  const unitByPath = createUnitByProjectPath(options.generatedGraph);
  const resourceCollector = new ResourceFactCollector(workspaceLookup);
  const result = new Map<string, SourceProjectFacts>();
  try {
    for (const entry of entries) {
      const project = {
        ...entry.project,
        fileNames: entry.fileNames,
        ownedFileNames: entry.fileNames,
      };
      const unit = unitByPath.get(project.configPath);
      const owner =
        workspaceLookup.findOwnerForFile(project.configPath) ??
        (entry.fileNames[0] === undefined
          ? null
          : workspaceLookup.findOwnerForFile(entry.fileNames[0]));
      const runtime = await prepareRuntimeProjectFacts({
        view,
        providers,
        project,
        unit,
        workspaceSourceBoundary,
        packageRootDir:
          unit?.packageRootDir ?? owner?.directory ?? options.rootDir,
      });
      const failure = runtime.failures[0];
      if (failure !== undefined)
        throw new Error(
          `Source-check semantic dependency collection failed at ${failure.stage}: ${failure.reason}`,
        );
      const governingProject =
        unit === undefined || unit.configPath === project.configPath
          ? project
          : await providers.tsconfig.getProject(unit.configPath, unit.context);
      const resources = resourceCollector.collect({
        collection: runtime,
        project: governingProject,
        checkerNames: entry.checkerNames,
        typeEvidence: providers.typeEvidence,
      });
      result.set(project.configPath, { runtime, resources });
      providers.typeEvidence.completeProject(governingProject.configPath);
    }
  } finally {
    resourceCollector.dispose();
  }
  return { entries, projectFacts: result };
}
