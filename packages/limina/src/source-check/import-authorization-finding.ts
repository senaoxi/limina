import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
} from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createSourceDiagnosticFinding } from './finding-utils';
import type {
  SourceFinding,
  SourcePackageImportUnauthorizedFacts,
} from './findings';
import {
  formatImportAuthorityGrantPath,
  getSourceOwnerIdentity,
} from './import-authority-grants';
import { getWorkspacePackageJsonPath } from './import-authorization-resolution';
import type { PackageImportAuthorizationResolution } from './source-types';

interface AuthorizationFindingOptions {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  findings: SourceFinding[];
  workspacePackage: WorkspacePackage | null;
}

interface AuthorizationPresentation {
  fix: string;
  lines: string[];
  ownerIdentity: string;
  reason: string;
  title: string;
}

function isSeparateTypePackage(options: {
  dependencySpecifier?: string;
  packageName: string;
}): boolean {
  const specifier = options.dependencySpecifier;
  if (!specifier) {
    return false;
  }

  if (!specifier.startsWith('@types/')) {
    return false;
  }

  return specifier !== options.packageName;
}

function createTypeDeclarationFix(options: {
  dependencySpecifier?: string;
  packageName: string;
}): string {
  if (!isSeparateTypePackage(options)) {
    return '';
  }

  return ` "${options.dependencySpecifier}" only supplies declarations and does not authorize "${options.packageName}".`;
}

function createIntermediateAuthorityFix(
  authorization: PackageImportAuthorizationResolution,
): string {
  return authorization.intermediateDependencyPackage
    ? ' Remove or relocate the intermediate declaration if it is not the intended authority, or avoid relying on workspace root dependency authority for this import.'
    : '';
}

function formatPackageImportAuthorizationFix(options: {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  owner: PackageOwner;
  ownerIdentity: string;
  packageName: string;
}): string {
  const ownerManifestPath = toRelativePath(
    options.config.rootDir,
    options.owner.packageJsonPath,
  );
  const rootAuthorityFix = ` If this package is intentionally declared by the workspace root, add source.importAuthority.allow["${options.ownerIdentity}"] with workspaceRootDependencies: ["${options.packageName}"] and a reason.`;

  return [
    `Declare "${options.packageName}" in ${ownerManifestPath} dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
    rootAuthorityFix,
    createIntermediateAuthorityFix(options.authorization),
    createTypeDeclarationFix(options),
  ]
    .filter(Boolean)
    .join(' ');
}

function rootManifestDoesNotDeclarePackage(
  options: AuthorizationFindingOptions,
): boolean {
  if (!options.authorization.matchedGrant) {
    return false;
  }

  const rootPackageJsonPath = normalizeAbsolutePath(
    path.join(options.config.rootDir, 'package.json'),
  );
  const conditions = [
    existsSync(rootPackageJsonPath),
    options.authorization.authorityManifestPaths.includes(rootPackageJsonPath),
    !options.authorization.intermediateDependencyPackage,
  ];

  return conditions.every(Boolean);
}

function getAuthorizationReason(options: {
  authorization: PackageImportAuthorizationResolution;
  packageName: string;
  rootManifestMissingDependency: boolean;
}): string {
  if (options.authorization.intermediateDependencyPackage) {
    return `source import authority can only use the owner package.json or an explicitly configured workspace root dependency grant. An intermediate workspace package declares "${options.packageName}", so the workspace root grant must not bypass it.`;
  }

  if (options.rootManifestMissingDependency) {
    return `the grant allows workspace root dependency authority, but the workspace root package.json does not declare "${options.packageName}".`;
  }

  return 'source imports must be declared by the nearest pnpm workspace source owner or by an explicitly configured workspace root dependency grant.';
}

function createOptionalLine(
  label: string,
  value: string | undefined,
): string[] {
  return value ? [`  ${label}: ${value}`] : [];
}

function getGrantPath(
  authorization: PackageImportAuthorizationResolution,
): string | undefined {
  const grant = authorization.matchedGrant;
  return grant ? formatImportAuthorityGrantPath(grant) : undefined;
}

function createGrantLines(
  authorization: PackageImportAuthorizationResolution,
): string[] {
  const grantPath = getGrantPath(authorization);
  return grantPath
    ? ['  matched import authority grant:', `    ${grantPath}`]
    : [];
}

function createIntermediateLines(options: {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
}): string[] {
  const intermediate = options.authorization.intermediateDependencyPackage;
  if (!intermediate) {
    return [];
  }

  return [
    '  intermediate dependency declaration:',
    `    package.json: ${toRelativePath(
      options.config.rootDir,
      getWorkspacePackageJsonPath(intermediate),
    )}`,
  ];
}

function getWorkspacePackageName(
  workspacePackage: WorkspacePackage | null,
): string | undefined {
  return workspacePackage ? workspacePackage.name : undefined;
}

function getOwnerName(owner: PackageOwner): string | undefined {
  return owner.name ?? undefined;
}

function getAuthorityReason(
  authorization: PackageImportAuthorizationResolution,
): string | undefined {
  return authorization.matchedGrant?.reason;
}

function getIntermediateDependencyName(
  authorization: PackageImportAuthorizationResolution,
): string | undefined {
  return authorization.intermediateDependencyPackage?.name ?? undefined;
}

function createAuthorizationPresentation(
  options: AuthorizationFindingOptions,
): AuthorizationPresentation {
  const ownerIdentity = getSourceOwnerIdentity({
    config: options.config,
    owner: options.owner,
  });
  const fix = formatPackageImportAuthorizationFix({
    authorization: options.authorization,
    config: options.config,
    dependencySpecifier: options.dependencySpecifier,
    owner: options.owner,
    ownerIdentity,
    packageName: options.packageName,
  });
  const reason = getAuthorizationReason({
    authorization: options.authorization,
    packageName: options.packageName,
    rootManifestMissingDependency: rootManifestDoesNotDeclarePackage(options),
  });
  const title = 'Unauthorized bare package import';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  owner identity: ${ownerIdentity}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  package: ${options.packageName}`,
    ...createOptionalLine(
      'resolved dependency specifier',
      options.dependencySpecifier,
    ),
    ...createOptionalLine(
      'workspace package',
      getWorkspacePackageName(options.workspacePackage),
    ),
    '  dependency authority manifests:',
    ...options.authorization.authorityManifestPaths.map(
      (manifestPath) =>
        `    - ${toRelativePath(options.config.rootDir, manifestPath)}`,
    ),
    ...createGrantLines(options.authorization),
    `  reason: ${reason}`,
    ...createIntermediateLines(options),
    `  fix: ${fix}`,
  ];

  return { fix, lines, ownerIdentity, reason, title };
}

function createAuthorizationFacts(options: {
  finding: AuthorizationFindingOptions;
  ownerIdentity: string;
}): SourcePackageImportUnauthorizedFacts {
  return {
    authorityManifestPaths:
      options.finding.authorization.authorityManifestPaths,
    authorityReason: getAuthorityReason(options.finding.authorization),
    dependencyName: options.finding.packageName,
    dependencySpecifier: options.finding.dependencySpecifier,
    importerPath: options.finding.importRecord.filePath,
    intermediateDependencyName: getIntermediateDependencyName(
      options.finding.authorization,
    ),
    kind: 'bare-package-import',
    line: options.finding.importRecord.line,
    ownerIdentity: options.ownerIdentity,
    packageManifestPath: options.finding.owner.packageJsonPath,
    packageName: getOwnerName(options.finding.owner),
    specifier: options.finding.importRecord.specifier,
    workspacePackageName: getWorkspacePackageName(
      options.finding.workspacePackage,
    ),
  };
}

export function addPackageImportAuthorizationProblem(
  options: AuthorizationFindingOptions,
): void {
  const presentation = createAuthorizationPresentation(options);

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized,
      facts: createAuthorizationFacts({
        finding: options,
        ownerIdentity: presentation.ownerIdentity,
      }),
      filePath: options.importRecord.filePath,
      fix: presentation.fix,
      lines: presentation.lines,
      ownerName: getOwnerName(options.owner),
      packageJsonPath: options.owner.packageJsonPath,
      reason: presentation.reason,
      title: presentation.title,
    }),
  );
}
