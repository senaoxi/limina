import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import type { PackageImportMatch } from '../core/packages/authority';
import type { NearestPackageInfo } from '../core/packages/owners';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { SourceFinding } from './findings';

export interface SourceProjectEntry {
  checkerNames: string[];
  fileNames: string[];
  project: ProjectInfo;
}

export interface TsconfigOwnershipResolution {
  matchedOwnerConfigPaths: string[];
  searchedTsconfigPaths: string[];
  status: 'matched' | 'missing' | 'multiple' | 'unmatched';
  tsconfigPath: string | null;
}

export interface CompiledImportAuthorityAllowRule {
  appliesToAllGovernedOwnerSources: boolean;
  grantIndex: number;
  includeMatchers: ((value: string) => boolean)[];
  ownerIdentity: string;
  packageMatchers: ((value: string) => boolean)[];
  reason: string;
}

export interface PackageImportValidationOptions {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  resolvedFilePath: string | null;
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
}

export interface ValidatedPackageImport extends PackageImportValidationOptions {
  match: PackageImportMatch;
  packageScope: NearestPackageInfo | null;
  resolvedFilePath: string;
}

export interface PackageImportAuthorizationResolution {
  authorityManifestPaths: string[];
  authorized: boolean;
  intermediateDependencyPackage?: WorkspacePackage;
  matchedGrant?: CompiledImportAuthorityAllowRule;
}
