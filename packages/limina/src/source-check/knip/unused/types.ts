import type { PackageOwner } from '#core/workspace/actions';

export interface OwnerSourceModuleSet {
  checkUnusedFiles: boolean;
  files: string[];
  owner: PackageOwner;
}

export interface UnusedModuleConfig {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredKeys: Set<string>;
}
