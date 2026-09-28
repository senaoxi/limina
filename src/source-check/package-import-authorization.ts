import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import type { NearestPackageInfo } from '../core/packages/owners';
import type { SourceFinding } from './findings';
import { addPackageImportAuthorizationProblem } from './import-authorization-finding';
import { resolvePackageImportAuthorization } from './import-authorization-resolution';
import { addResolvedPackageWithoutNameProblem } from './package-import-target-findings';
import type { CompiledImportAuthorityAllowRule } from './source-types';

export function addPackageImportArtifactAuthorizationProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  packageInfo: NearestPackageInfo;
  rootPackage: WorkspacePackage | null;
  workspacePackage: WorkspacePackage | null;
}): void {
  const packageName = options.packageInfo.name;
  if (!packageName) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      findings: options.findings,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.packageInfo,
    });
    return;
  }

  const authorization = resolvePackageImportAuthorization({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName,
    packages: options.packages,
    rootPackage: options.rootPackage,
  });
  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName,
    findings: options.findings,
    workspacePackage: options.workspacePackage,
  });
}
