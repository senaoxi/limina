import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import type { WorkspaceDependencyDeclaration } from '../../core/packages/authority';
import type { PackageOwnerIdentity } from '../../core/workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { SourceFinding } from '../findings';
import type { KnipOwnerProject, KnipSourceAnalysisGroup } from '../knip';
import { collectUnusedDependencyIgnore } from './dependency-ignore';
import { collectGeneratedArtifactSourceEntryPatterns } from './generated-entries';
import { createKnipOwnerProjects } from './owner-projects';
import {
  createKnipSourceAnalysisGroups,
  type SourceKnipWorkspaceConfigRecord,
} from './routing';
import type { OwnerSourceModuleSet } from './unused';
import { collectUnusedModuleConfig } from './unused/config';

export interface KnipAnalysisPlan {
  analysisGroups: KnipSourceAnalysisGroup[];
  ignoredDependencies: Set<string>;
  ignoredModuleKeys: Set<string>;
  includeFiles: boolean;
  needsDependencyAnalysis: boolean;
  ownerProjects: KnipOwnerProject[];
}

function collectRequiredOwnerIdentities(options: {
  declarations: WorkspaceDependencyDeclaration[];
  knipWorkspaceConfigs: Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >;
  ownerModuleSets: OwnerSourceModuleSet[];
}): Set<PackageOwnerIdentity> {
  return new Set([
    ...options.declarations.map((declaration) => declaration.importerIdentity),
    ...options.ownerModuleSets.map((moduleSet) => moduleSet.ownerIdentity),
    ...options.knipWorkspaceConfigs.keys(),
  ]);
}

function createEntryPatternsByOwnerIdentity(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  ownerModuleSets: OwnerSourceModuleSet[];
  configuredPatterns: Map<PackageOwnerIdentity, string[]>;
  workspaceContext: ValidatedWorkspaceContext;
}): Map<PackageOwnerIdentity, string[]> {
  return new Map(
    options.ownerModuleSets.flatMap((moduleSet) => {
      const ownerIdentity = moduleSet.ownerIdentity;

      return [
        [
          ownerIdentity,
          uniqueSortedStrings([
            ...(options.configuredPatterns.get(ownerIdentity) ?? []),
            ...collectGeneratedArtifactSourceEntryPatterns({
              generatedGraph: options.generatedGraph,
              workspaceContext: options.workspaceContext,
              moduleSet,
            }),
          ]),
        ] as const,
      ];
    }),
  );
}

export function createKnipAnalysisPlan(options: {
  config: ResolvedLiminaConfig;
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  knipWorkspaceConfigs: Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >;
  ownerModuleSets: OwnerSourceModuleSet[];
  workspacePackages: WorkspacePackage[];
  workspaceContext: ValidatedWorkspaceContext;
}): KnipAnalysisPlan {
  const ignoredDependencies = collectUnusedDependencyIgnore({
    declarations: options.declarations,
    findings: options.findings,
    knipWorkspaceConfigs: options.knipWorkspaceConfigs,
    workspacePackages: options.workspacePackages,
  });
  const unusedModuleConfig = collectUnusedModuleConfig({
    config: options.config,
    findings: options.findings,
    knipWorkspaceConfigs: options.knipWorkspaceConfigs,
    ownerModuleSets: options.ownerModuleSets,
  });
  const includeFiles = options.ownerModuleSets.length > 0;
  const needsDependencyAnalysis =
    options.workspacePackages.length > 0 && options.declarations.length > 0;
  const ownerProjects = createKnipOwnerProjects({
    entryPatternsByOwnerIdentity: createEntryPatternsByOwnerIdentity({
      configuredPatterns: unusedModuleConfig.entryPatternsByOwnerIdentity,
      workspaceContext: options.workspaceContext,
      generatedGraph: options.generatedGraph,
      ownerModuleSets: options.ownerModuleSets,
    }),
    ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
    includeFiles,
    ownerModuleSets: options.ownerModuleSets,
  });

  return {
    analysisGroups: createKnipSourceAnalysisGroups({
      config: options.config,
      generatedGraph: options.generatedGraph,
      requiredOwnerIdentities: collectRequiredOwnerIdentities({
        declarations: options.declarations,
        knipWorkspaceConfigs: options.knipWorkspaceConfigs,
        ownerModuleSets: options.ownerModuleSets,
      }),
      workspacePackages: options.workspacePackages,
      workspaceContext: options.workspaceContext,
    }),
    ignoredDependencies,
    ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
    includeFiles,
    needsDependencyAnalysis,
    ownerProjects,
  };
}
