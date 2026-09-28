import type { ResolvedLiminaConfig } from '#config/runner';
import type { PackageOwnerIdentity } from '../../../core/workspace/owner-identity';
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
  knipWorkspaceConfigs: Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >;
  ownerModuleSets: OwnerSourceModuleSet[];
}): UnusedModuleConfig {
  const context = createUnusedModuleConfigContext(options);
  for (const [ownerIdentity, workspaceConfig] of options.knipWorkspaceConfigs) {
    collectWorkspaceConfig({ context, ownerIdentity, workspaceConfig });
  }
  return {
    entryPatternsByOwnerIdentity: context.entryPatternsByOwnerIdentity,
    ignoredKeys: context.ignoredKeys,
  };
}
