import type { ResolvedLiminaConfig } from '#config/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import type {
  ResourceProjectFacts,
  ResourceProjectImport,
} from '../core/facts/resource';
import type { SourceProjectFacts } from '../core/facts/source-projects';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
import type { CheckCounter } from '../execution/stats';
import type { SourceFinding } from './findings';
import { addImportRecordProblems } from './import-record-validation';
import { addResourceModuleProblems } from './resource-module-findings';
import type {
  CompiledImportAuthorityAllowRule,
  SourceProjectEntry,
} from './source-types';

interface SourceImportOptions {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  packages: WorkspacePackage[];
  pathIndex: WorkspaceRegionPathIndex;
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
}

function processCollectedImport(options: {
  base: SourceImportOptions;
  collected: ResourceProjectImport;
  project: ProjectInfo;
  resourceFacts: ResourceProjectFacts;
}): void {
  const { base, collected, project, resourceFacts } = options;
  const { importRecord } = collected;
  const { filePath } = importRecord;
  const owner = base.workspaceLookup.findOwnerForFile(filePath);
  if (owner === null) return;

  base.checks.add();
  const resources = resourceFacts.get(collected) ?? [];
  for (const resource of resources) {
    addResourceModuleProblems({
      config: base.config,
      configPath: project.configPath,
      findings: base.findings,
      importRecord,
      owner,
      resource,
    });
  }
  addImportRecordProblems({
    config: base.config,
    filePath,
    importAuthorityAllowRules: base.importAuthorityAllowRules,
    importRecord,
    owner,
    packages: base.packages,
    pathIndex: base.pathIndex,
    findings: base.findings,
    project,
    resolvedFilePath:
      'resolvedFilePath' in collected ? collected.resolvedFilePath : null,
    rootPackage: base.rootPackage,
    workspaceLookup: base.workspaceLookup,
  });
}

export function addSourceImportProblems(
  options: SourceImportOptions & {
    projectFacts: ReadonlyMap<string, SourceProjectFacts>;
    sourceProjectEntries: SourceProjectEntry[];
  },
): void {
  for (const { project } of options.sourceProjectEntries) {
    const facts = options.projectFacts.get(project.configPath);
    if (facts === undefined) {
      throw new Error(
        `Missing prepared import facts for source-check project ${project.configPath}.`,
      );
    }
    for (const imports of [
      facts.runtime.dependencies,
      facts.runtime.observations,
    ]) {
      for (const collected of imports) {
        if (!('importRecord' in collected)) continue;
        processCollectedImport({
          base: options,
          collected,
          project,
          resourceFacts: facts.resources,
        });
      }
    }
  }
}
