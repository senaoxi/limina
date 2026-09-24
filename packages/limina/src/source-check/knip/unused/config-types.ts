import type { ResolvedLiminaConfig } from '#config/runner';
import type { PackageOwnerIdentity } from '../../../core/workspace/owner-identity';
import type { SourceFinding } from '../../findings';
import type { SourceKnipWorkspaceConfigRecord } from '../routing';
import type { OwnerSourceModuleSet } from './types';

export interface ParsedEntryRecord {
  files: unknown[];
  reason: string;
}

export interface UnusedModuleConfigContext {
  config: ResolvedLiminaConfig;
  entryPatternsByOwnerIdentity: Map<PackageOwnerIdentity, string[]>;
  findings: SourceFinding[];
  ignoredKeys: Set<string>;
  moduleFilesByOwnerIdentity: Map<PackageOwnerIdentity, Set<string>>;
  moduleSetByOwnerIdentity: Map<PackageOwnerIdentity, OwnerSourceModuleSet>;
}

export interface WorkspaceUnusedConfigOptions {
  context: UnusedModuleConfigContext;
  ownerIdentity: PackageOwnerIdentity;
  workspaceConfig: SourceKnipWorkspaceConfigRecord;
}

export function createUnusedModuleConfigContext(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  ownerModuleSets: OwnerSourceModuleSet[];
}): UnusedModuleConfigContext {
  return {
    config: options.config,
    entryPatternsByOwnerIdentity: new Map(),
    findings: options.findings,
    ignoredKeys: new Set(),
    moduleFilesByOwnerIdentity: new Map(
      options.ownerModuleSets.map((moduleSet) => [
        moduleSet.ownerIdentity,
        new Set(moduleSet.files),
      ]),
    ),
    moduleSetByOwnerIdentity: new Map(
      options.ownerModuleSets.map((moduleSet) => [
        moduleSet.ownerIdentity,
        moduleSet,
      ]),
    ),
  };
}
