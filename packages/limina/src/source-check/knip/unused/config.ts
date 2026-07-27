import type { ResolvedLiminaConfig } from '#config/runner';
import type { SourceFinding } from '../../findings';
import { collectWorkspaceEntryConfig } from '../entry-config';
import { collectWorkspaceFileIgnoreConfig } from '../file-ignore';
import type { SourceKnipWorkspaceConfigRecord } from '../routing';
import {
  createUnusedModuleConfigContext,
  type WorkspaceUnusedConfigOptions,
} from './config-types';
import type { OwnerSourceModuleSet, UnusedModuleConfig } from './types';

function collectWorkspaceConfig(options: WorkspaceUnusedConfigOptions): void {
  collectWorkspaceEntryConfig(options);
  collectWorkspaceFileIgnoreConfig(options);
}

export function collectUnusedModuleConfig(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  ownerModuleSets: OwnerSourceModuleSet[];
}): UnusedModuleConfig {
  const context = createUnusedModuleConfigContext(options);
  for (const [ownerName, workspaceConfig] of options.knipWorkspaceConfigs) {
    collectWorkspaceConfig({ context, ownerName, workspaceConfig });
  }
  return {
    entryPatternsByOwnerName: context.entryPatternsByOwnerName,
    ignoredKeys: context.ignoredKeys,
  };
}
