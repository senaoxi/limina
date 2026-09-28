import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import {
  getPackageRootSpecifier,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  isBarePackageSpecifier,
  isUrlOrDataOrFileSpecifier,
  isVirtualModuleSpecifier,
} from '#utils/module-specifier';
import type { ResolvedPackageTarget } from '../core/packages/owners';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { isNodeBuiltinSpecifier } from '../graph-check/rules';
import type { SourceFinding } from './findings';
import { addPackageImportAuthorizationProblem } from './import-authorization-finding';
import { resolvePackageImportAuthorization } from './import-authorization-resolution';
import { addResolvedPackageWithoutNameProblem } from './package-import-target-findings';
import type { CompiledImportAuthorityAllowRule } from './source-types';

interface BareImportOptions {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
}

interface PackageAuthorityTarget {
  requestedPackageName: string;
  resolvedPackageName?: string;
}

function isCommentDependency(importRecord: ImportRecord): boolean {
  return [
    'jsdoc-import',
    'triple-slash-path',
    'triple-slash-types',
    'jsx-import-source',
    'environment-pragma',
  ].includes(importRecord.kind);
}

export function shouldSkipBarePackageAuthorization(
  importRecord: ImportRecord,
): boolean {
  const predicates = [
    isUrlOrDataOrFileSpecifier(importRecord.specifier),
    isVirtualModuleSpecifier(importRecord.specifier),
    !isBarePackageSpecifier(importRecord.specifier),
    isCommentDependency(importRecord),
    isNodeBuiltinSpecifier(importRecord.specifier),
  ];

  return predicates.includes(true);
}

function getBarePackageImportAuthorityTarget(options: {
  importRecord: ImportRecord;
  resolvedPackageName?: string;
}): PackageAuthorityTarget {
  const requestedPackageName = getPackageRootSpecifier(
    options.importRecord.specifier,
  );

  return options.resolvedPackageName
    ? { requestedPackageName, resolvedPackageName: options.resolvedPackageName }
    : { requestedPackageName };
}

function getResolvedPackageNameDiagnostic(
  authorityTarget: PackageAuthorityTarget,
): string | undefined {
  const resolvedName = authorityTarget.resolvedPackageName;
  if (!resolvedName) {
    return undefined;
  }

  return resolvedName === authorityTarget.requestedPackageName
    ? undefined
    : resolvedName;
}

function addUnauthorizedBarePackage(options: {
  base: BareImportOptions;
  resolvedPackageName?: string;
  workspacePackage: WorkspacePackage | null;
}): void {
  const authorityTarget = getBarePackageImportAuthorityTarget({
    importRecord: options.base.importRecord,
    resolvedPackageName: options.resolvedPackageName,
  });
  const authorization = resolvePackageImportAuthorization({
    config: options.base.config,
    importAuthorityAllowRules: options.base.importAuthorityAllowRules,
    importRecord: options.base.importRecord,
    owner: options.base.owner,
    packageName: authorityTarget.requestedPackageName,
    packages: options.base.packages,
    rootPackage: options.base.rootPackage,
  });
  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.base.config,
    dependencySpecifier: getResolvedPackageNameDiagnostic(authorityTarget),
    importRecord: options.base.importRecord,
    owner: options.base.owner,
    packageName: authorityTarget.requestedPackageName,
    findings: options.base.findings,
    workspacePackage: options.workspacePackage,
  });
}

function handleOtherOwnerTarget(options: {
  base: BareImportOptions;
  target: Extract<ResolvedPackageTarget, { kind: 'other-owner' }>;
}): void {
  const resolvedPackageName =
    options.target.packageInfo.name ?? options.target.targetOwner.name;
  if (!resolvedPackageName) {
    addResolvedPackageWithoutNameProblem({
      config: options.base.config,
      findings: options.base.findings,
      importRecord: options.base.importRecord,
      owner: options.base.owner,
      packageInfo: options.target.packageInfo,
    });
    return;
  }

  addUnauthorizedBarePackage({
    base: options.base,
    resolvedPackageName,
    workspacePackage: options.target.workspacePackage,
  });
}

function handleArtifactTarget(options: {
  base: BareImportOptions;
  target: Extract<ResolvedPackageTarget, { kind: 'artifact-package' }>;
}): void {
  const resolvedPackageName = options.target.packageInfo.name;
  if (!resolvedPackageName) {
    addResolvedPackageWithoutNameProblem({
      config: options.base.config,
      findings: options.base.findings,
      importRecord: options.base.importRecord,
      owner: options.base.owner,
      packageInfo: options.target.packageInfo,
    });
    return;
  }

  addUnauthorizedBarePackage({
    base: options.base,
    resolvedPackageName,
    workspacePackage: null,
  });
}

function processOwnedTarget(options: {
  base: BareImportOptions;
  target: ResolvedPackageTarget;
}): boolean {
  if (options.target.kind === 'current-owner') {
    return true;
  }

  if (options.target.kind !== 'other-owner') {
    return false;
  }

  handleOtherOwnerTarget({ base: options.base, target: options.target });
  return true;
}

function processArtifactTarget(options: {
  base: BareImportOptions;
  target: ResolvedPackageTarget;
}): boolean {
  if (options.target.kind !== 'artifact-package') {
    return false;
  }

  handleArtifactTarget({ base: options.base, target: options.target });
  return true;
}

function processResolvedTarget(options: {
  base: BareImportOptions;
  target: ResolvedPackageTarget;
}): boolean {
  if (processOwnedTarget(options)) {
    return true;
  }

  return processArtifactTarget(options);
}

function processResolvedBareImport(options: {
  base: BareImportOptions;
  resolvedFilePath: string | null;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  if (!options.resolvedFilePath) {
    return false;
  }

  const target = options.workspaceLookup.classifyResolvedPackageTarget({
    owner: options.base.owner,
    resolvedFilePath: options.resolvedFilePath,
  });
  return processResolvedTarget({ base: options.base, target });
}

function findWorkspacePackage(
  packages: WorkspacePackage[],
  packageName: string,
): WorkspacePackage | null {
  const workspacePackage = packages.find(
    (candidate) => candidate.name === packageName,
  );

  return workspacePackage ?? null;
}

function shouldIgnoreSelfImport(options: {
  fallbackPackageName: string;
  owner: PackageOwner;
}): boolean {
  return options.owner.name === options.fallbackPackageName;
}

export function addBarePackageImportProblems(
  options: BareImportOptions & {
    fallbackPackageName: string;
    resolvedFilePath: string | null;
    workspaceLookup: WorkspaceLookupIndex;
  },
): void {
  if (shouldIgnoreSelfImport(options)) {
    return;
  }

  if (
    processResolvedBareImport({
      base: options,
      resolvedFilePath: options.resolvedFilePath,
      workspaceLookup: options.workspaceLookup,
    })
  ) {
    return;
  }

  const workspacePackage = findWorkspacePackage(
    options.packages,
    options.fallbackPackageName,
  );
  addUnauthorizedBarePackage({
    base: options,
    workspacePackage,
  });
}
