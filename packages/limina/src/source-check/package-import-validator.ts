import {
  findPackageImportMatch,
  type PackageImportMatch,
} from '../core/packages/authority';
import type {
  NearestPackageInfo,
  ResolvedPackageTarget,
} from '../core/packages/owners';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { addPackageImportArtifactAuthorizationProblem } from './package-import-authorization';
import {
  addPackageImportOutsideSourceOwnership,
  addUnauthorizedPackageImportSpecifier,
  addUnresolvedPackageImportSpecifier,
} from './package-import-specifier-findings';
import {
  addPackageImportOtherOwnerProblem,
  addPackageImportRelativeScopeProblem,
} from './package-import-target-findings';
import type {
  PackageImportValidationOptions,
  ValidatedPackageImport,
} from './source-types';

type PackageImportOptions = PackageImportValidationOptions;

function getMatchedImport(options: PackageImportOptions): {
  match: PackageImportMatch;
  packageScope: NearestPackageInfo | null;
} | null {
  const packageScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.importRecord.filePath,
  );
  const match = findPackageImportMatch(
    packageScope ? packageScope.manifest.imports : undefined,
    options.importRecord.specifier,
  );
  if (!match) {
    addUnauthorizedPackageImportSpecifier({ ...options, packageScope });
    return null;
  }

  return { match, packageScope };
}

function getResolvedImport(options: {
  base: PackageImportOptions;
  match: PackageImportMatch;
  packageScope: NearestPackageInfo | null;
}): ValidatedPackageImport | null {
  if (!options.base.resolvedFilePath) {
    addUnresolvedPackageImportSpecifier({
      ...options.base,
      packageScope: options.packageScope,
    });
    return null;
  }

  return {
    ...options.base,
    match: options.match,
    packageScope: options.packageScope,
    resolvedFilePath: options.base.resolvedFilePath,
  };
}

function isResolvedInsidePackageScope(options: {
  packageScope: NearestPackageInfo;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  return (
    options.workspaceLookup.findNearestPackageScopeInfo(
      options.resolvedFilePath,
    )?.packageJsonPath === options.packageScope.packageJsonPath
  );
}

function shouldTreatAsRelativeTarget(
  match: ValidatedPackageImport['match'],
): boolean {
  return match.targetKind === 'relative';
}

function shouldTreatAsPackageTarget(
  match: ValidatedPackageImport['match'],
): boolean {
  return ['package', 'mixed'].includes(match.targetKind);
}

function hasEscapedRelativeTarget(context: ValidatedPackageImport): boolean {
  if (!context.packageScope) {
    return false;
  }

  const conditions = [
    shouldTreatAsRelativeTarget(context.match),
    !isResolvedInsidePackageScope({
      packageScope: context.packageScope,
      resolvedFilePath: context.resolvedFilePath,
      workspaceLookup: context.workspaceLookup,
    }),
  ];

  return conditions.every(Boolean);
}

function addRelativeScopeFinding(context: ValidatedPackageImport): void {
  addPackageImportRelativeScopeProblem({
    config: context.config,
    findings: context.findings,
    importRecord: context.importRecord,
    owner: context.owner,
    packageScope: context.packageScope!,
    resolvedFilePath: context.resolvedFilePath,
    targetPackageScope: context.workspaceLookup.findNearestPackageScopeInfo(
      context.resolvedFilePath,
    ),
  });
}

function rejectEscapedRelativeTarget(
  context: ValidatedPackageImport | null,
): ValidatedPackageImport | null {
  if (!context) {
    return null;
  }

  if (!hasEscapedRelativeTarget(context)) {
    return context;
  }

  addRelativeScopeFinding(context);
  return null;
}

function getValidatedPackageImport(
  options: PackageImportOptions,
): ValidatedPackageImport | null {
  const matched = getMatchedImport(options);
  if (!matched) {
    return null;
  }

  return rejectEscapedRelativeTarget(
    getResolvedImport({ base: options, ...matched }),
  );
}

function shouldCurrentOwnerStayInScope(
  context: ValidatedPackageImport,
): boolean {
  if (!context.packageScope) {
    return true;
  }

  const conditions = [
    shouldTreatAsPackageTarget(context.match),
    isResolvedInsidePackageScope({
      packageScope: context.packageScope,
      resolvedFilePath: context.resolvedFilePath,
      workspaceLookup: context.workspaceLookup,
    }),
  ];

  return conditions.includes(true);
}

function handleCurrentOwnerContext(context: ValidatedPackageImport): void {
  if (!shouldCurrentOwnerStayInScope(context)) {
    addRelativeScopeFinding(context);
  }
}

function handleCurrentOwnerTarget(options: {
  context: ValidatedPackageImport;
  target: ResolvedPackageTarget;
}): boolean {
  if (options.target.kind !== 'current-owner') {
    return false;
  }

  handleCurrentOwnerContext(options.context);
  return true;
}

function addOtherOwnerAuthorization(options: {
  context: ValidatedPackageImport;
  target: Extract<ResolvedPackageTarget, { kind: 'other-owner' }>;
}): void {
  addPackageImportArtifactAuthorizationProblem({
    config: options.context.config,
    findings: options.context.findings,
    importAuthorityAllowRules: options.context.importAuthorityAllowRules,
    importRecord: options.context.importRecord,
    owner: options.context.owner,
    packages: options.context.packages,
    packageInfo: options.target.packageInfo,
    rootPackage: options.context.rootPackage,
    workspacePackage: options.target.workspacePackage,
  });
}

function handleOtherOwnerContext(options: {
  context: ValidatedPackageImport;
  target: Extract<ResolvedPackageTarget, { kind: 'other-owner' }>;
}): void {
  if (shouldTreatAsPackageTarget(options.context.match)) {
    addOtherOwnerAuthorization(options);
    return;
  }

  addPackageImportOtherOwnerProblem({
    config: options.context.config,
    findings: options.context.findings,
    importRecord: options.context.importRecord,
    owner: options.context.owner,
    resolvedFilePath: options.context.resolvedFilePath,
    targetOwner: options.target.targetOwner,
    workspacePackage: options.target.workspacePackage,
  });
}

function handleOtherOwnerTarget(options: {
  context: ValidatedPackageImport;
  target: ResolvedPackageTarget;
}): boolean {
  if (options.target.kind !== 'other-owner') {
    return false;
  }

  handleOtherOwnerContext({
    context: options.context,
    target: options.target,
  });
  return true;
}

function handleOwnedTarget(options: {
  context: ValidatedPackageImport;
  target: ResolvedPackageTarget;
}): boolean {
  if (handleCurrentOwnerTarget(options)) {
    return true;
  }

  return handleOtherOwnerTarget(options);
}

function handleArtifactTarget(options: {
  context: ValidatedPackageImport;
  target: ResolvedPackageTarget;
}): boolean {
  if (options.target.kind !== 'artifact-package') {
    return false;
  }

  addPackageImportArtifactAuthorizationProblem({
    config: options.context.config,
    findings: options.context.findings,
    importAuthorityAllowRules: options.context.importAuthorityAllowRules,
    importRecord: options.context.importRecord,
    owner: options.context.owner,
    packages: options.context.packages,
    packageInfo: options.target.packageInfo,
    rootPackage: options.context.rootPackage,
    workspacePackage: null,
  });
  return true;
}

function processUnownedTarget(options: {
  context: ValidatedPackageImport;
  target: ResolvedPackageTarget;
}): void {
  if (!handleArtifactTarget(options)) {
    addPackageImportOutsideSourceOwnership(options.context);
  }
}

function processResolvedTarget(context: ValidatedPackageImport): void {
  const target = context.workspaceLookup.classifyResolvedPackageTarget({
    owner: context.owner,
    resolvedFilePath: context.resolvedFilePath,
  });
  if (!handleOwnedTarget({ context, target })) {
    processUnownedTarget({ context, target });
  }
}

export function addPackageImportProblem(options: PackageImportOptions): void {
  const context = getValidatedPackageImport(options);
  if (!context) {
    return;
  }

  processResolvedTarget(context);
}
