import type { PackageOwner } from '#core/workspace/actions';
import type { PackageOwnerIdentity } from '../../../core/workspace/owner-identity';

export interface OwnerSourceModuleSet {
  checkUnusedFiles: boolean;
  files: string[];
  owner: PackageOwner;
  ownerIdentity: PackageOwnerIdentity;
}

export interface UnusedModuleConfig {
  entryPatternsByOwnerIdentity: Map<PackageOwnerIdentity, string[]>;
  ignoredKeys: Set<string>;
}
