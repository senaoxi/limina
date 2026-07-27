import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { uniqueSortedStrings } from '#utils/collections';
import type { WorkspaceDependencyDeclaration } from '../../core/packages/authority';
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

function collectRequiredWorkspaceNames(options: {
  declarations: WorkspaceDependencyDeclaration[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  ownerModuleSets: OwnerSourceModuleSet[];
}): Set<string> {
  return new Set([
    ...options.declarations.map((declaration) => declaration.importer.name),
    ...options.ownerModuleSets.flatMap((moduleSet) =>
      moduleSet.owner.name ? [moduleSet.owner.name] : [],
    ),
    ...options.knipWorkspaceConfigs.keys(),
  ]);
}

function createEntryPatternsByOwnerName(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  ownerModuleSets: OwnerSourceModuleSet[];
  configuredPatterns: Map<string, string[]>;
}): Map<string, string[]> {
  return new Map(
    options.ownerModuleSets.flatMap((moduleSet) => {
      const ownerName = moduleSet.owner.name;
      if (!ownerName) {
        return [];
      }

      return [
        [
          ownerName,
          uniqueSortedStrings([
            ...(options.configuredPatterns.get(ownerName) ?? []),
            ...collectGeneratedArtifactSourceEntryPatterns({
              generatedGraph: options.generatedGraph,
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
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  ownerModuleSets: OwnerSourceModuleSet[];
  workspacePackages: WorkspacePackage[];
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
    entryPatternsByOwnerName: createEntryPatternsByOwnerName({
      configuredPatterns: unusedModuleConfig.entryPatternsByOwnerName,
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
      requiredWorkspaceNames: collectRequiredWorkspaceNames({
        declarations: options.declarations,
        knipWorkspaceConfigs: options.knipWorkspaceConfigs,
        ownerModuleSets: options.ownerModuleSets,
      }),
      workspacePackages: options.workspacePackages,
    }),
    ignoredDependencies,
    ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
    includeFiles,
    needsDependencyAnalysis,
    ownerProjects,
  };
}
