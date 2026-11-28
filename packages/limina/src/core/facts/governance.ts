import type { AnalysisProviderSet } from '#core';
import type {
  CheckerSelectionResolution,
  GovernedSourceUnit,
} from '../build-graph/types';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import type { ProjectInfo } from '../import-graph/project-types';
import {
  createAutoProjectSemanticContext,
  createParsedProjectSemanticContext,
} from '../project-dependencies/context';
import type { ProjectDependencyCollection } from '../project-dependencies/contracts';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import type { CoreFactSession, SubscribedCoreFactView } from './session';

export function prepareGovernedRuntime(options: {
  facts: CoreFactSession;
  ownership: Pick<CheckerSelectionResolution, 'frozenProjectsByConfigPath'>;
  importAnalysis: ImportAnalysisContext;
  unit: GovernedSourceUnit;
}): ProjectDependencyCollection {
  const { facts, unit } = options;
  const existing = facts.getGovernedRuntime(unit);
  if (existing !== undefined) return existing;
  const frozen = options.ownership.frozenProjectsByConfigPath.get(
    unit.configPath,
  );
  if (frozen === undefined)
    throw new Error(`Missing frozen semantic project for ${unit.configPath}.`);
  const execution = unit.executionConfig;
  const context = createAutoProjectSemanticContext({
    authority: unit.semanticAuthority,
    project: frozen.project,
    workspaceSourceBoundary:
      execution === undefined
        ? facts.getLockedWorkspaceSourceBoundary()
        : facts.getWorkspaceSourceBoundary(),
  });
  const collection = facts.prepareRuntimeProjectDependencies({
    runtimeFileNames: unit.ownedFileNames,
    context: {
      ...context,
      astroSemanticProject:
        unit.astroSemanticProject ?? context.astroSemanticProject,
      svelteSemanticProject:
        unit.svelteSemanticProject ?? context.svelteSemanticProject,
      ...(execution !== undefined && {
        compilerOptions: execution.options,
        references: execution.references,
        resolverConfigPath: execution.configPath,
        virtualFiles: execution.virtualFiles,
      }),
    },
    importAnalysis: options.importAnalysis,
  });
  return facts.publishGovernedRuntime(unit, collection);
}

export async function prepareRuntimeProjectFacts(options: {
  view: SubscribedCoreFactView;
  providers: AnalysisProviderSet;
  project: ProjectInfo;
  unit?: GovernedSourceUnit;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
  packageRootDir: string;
}): Promise<ProjectDependencyCollection> {
  const { providers, project, unit } = options;
  if (unit !== undefined) {
    if (providers.facts.getGovernedRuntime(unit) === undefined) {
      prepareGovernedRuntime({
        facts: providers.facts,
        ownership: await providers.ownership.getOwnershipProjection(),
        unit,
        importAnalysis: providers.imports.context,
      });
    }
    return options.view.getRuntimeProjectDependencies(unit);
  }
  const authority = project.semanticAuthority;
  if (authority === undefined)
    throw new Error(
      `Missing frozen semantic authority for ${project.configPath}.`,
    );
  return providers.facts.prepareRuntimeProjectDependencies({
    context: createParsedProjectSemanticContext({
      authority,
      project,
      packageRootDir: options.packageRootDir,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    }),
    importAnalysis: providers.imports.context,
  });
}
