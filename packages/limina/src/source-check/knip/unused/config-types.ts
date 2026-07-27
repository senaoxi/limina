import type { ResolvedLiminaConfig } from '#config/runner';
import type { SourceFinding } from '../../findings';
import type { SourceKnipWorkspaceConfigRecord } from '../routing';
import type { OwnerSourceModuleSet } from './types';

export interface ParsedEntryRecord {
  files: unknown[];
  reason: string;
}

export interface UnusedModuleConfigContext {
  config: ResolvedLiminaConfig;
  entryPatternsByOwnerName: Map<string, string[]>;
  findings: SourceFinding[];
  ignoredKeys: Set<string>;
  moduleFilesByOwnerName: Map<string, Set<string>>;
  moduleSetByOwnerName: Map<string, OwnerSourceModuleSet>;
}

export interface WorkspaceUnusedConfigOptions {
  context: UnusedModuleConfigContext;
  ownerName: string;
  workspaceConfig: SourceKnipWorkspaceConfigRecord;
}

export function createUnusedModuleConfigContext(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  ownerModuleSets: OwnerSourceModuleSet[];
}): UnusedModuleConfigContext {
  return {
    config: options.config,
    entryPatternsByOwnerName: new Map(),
    findings: options.findings,
    ignoredKeys: new Set(),
    moduleFilesByOwnerName: new Map(
      options.ownerModuleSets.map((moduleSet) => [
        moduleSet.owner.name as string,
        new Set(moduleSet.files),
      ]),
    ),
    moduleSetByOwnerName: new Map(
      options.ownerModuleSets.map((moduleSet) => [
        moduleSet.owner.name as string,
        moduleSet,
      ]),
    ),
  };
}
