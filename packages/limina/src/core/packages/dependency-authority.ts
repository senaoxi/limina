import type {
  PackageManifest,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
} from '../workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';

type DependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

interface DependencyDeclaration {
  sectionName: DependencySectionName;
  specifier: string;
}

export interface WorkspaceDependencyDeclaration {
  dependencyName: string;
  importer: WorkspacePackage;
  importerIdentity: PackageOwnerIdentity;
  packageJsonPath: string;
  sectionName: DependencySectionName;
  specifier: string;
}

const dependencySectionNames: readonly DependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function getDependencySection(
  manifest: PackageManifest,
  sectionName: DependencySectionName,
): Record<string, string> | null {
  const section = manifest[sectionName];

  if (!isPlainRecord(section)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(section).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function collectSectionDeclaration(
  manifest: PackageManifest,
  packageName: string,
  sectionName: DependencySectionName,
): DependencyDeclaration[] {
  const specifier = getDependencySection(manifest, sectionName)?.[packageName];
  return specifier === undefined ? [] : [{ sectionName, specifier }];
}

function collectDependencyDeclarations(
  manifest: PackageManifest,
  packageName: string,
): DependencyDeclaration[] {
  return dependencySectionNames.flatMap((sectionName) =>
    collectSectionDeclaration(manifest, packageName, sectionName),
  );
}

export function createWorkspaceDependencyKey(
  importerIdentity: PackageOwnerIdentity,
  dependencyName: string,
): string {
  return `${importerIdentity}\0${dependencyName}`;
}

function getWorkspacePackageJsonPath(
  workspacePackage: WorkspacePackage,
): string {
  return path.join(workspacePackage.directory, 'package.json');
}

function collectImporterSectionDeclarations(options: {
  importer: WorkspacePackage;
  importerIdentity: PackageOwnerIdentity;
  sectionName: DependencySectionName;
  workspacePackageIdentities: ReadonlyMap<string, PackageOwnerIdentity>;
}): WorkspaceDependencyDeclaration[] {
  const section = getDependencySection(
    options.importer.manifest,
    options.sectionName,
  );

  if (section === null) {
    return [];
  }

  return Object.entries(section)
    .filter(
      ([dependencyName]) =>
        options.workspacePackageIdentities.has(dependencyName) &&
        options.workspacePackageIdentities.get(dependencyName) !==
          options.importerIdentity,
    )
    .map(([dependencyName, specifier]) => ({
      dependencyName,
      importer: options.importer,
      importerIdentity: options.importerIdentity,
      packageJsonPath: getWorkspacePackageJsonPath(options.importer),
      sectionName: options.sectionName,
      specifier,
    }));
}

function collectImporterDeclarations(
  importer: WorkspacePackage,
  importerIdentity: PackageOwnerIdentity,
  workspacePackageIdentities: ReadonlyMap<string, PackageOwnerIdentity>,
): WorkspaceDependencyDeclaration[] {
  return dependencySectionNames.flatMap((sectionName) =>
    collectImporterSectionDeclarations({
      importer,
      sectionName,
      importerIdentity,
      workspacePackageIdentities,
    }),
  );
}

function compareWorkspaceDeclarations(
  left: WorkspaceDependencyDeclaration,
  right: WorkspaceDependencyDeclaration,
): number {
  const pathDifference = left.packageJsonPath.localeCompare(
    right.packageJsonPath,
  );
  if (pathDifference !== 0) {
    return pathDifference;
  }

  const dependencyDifference = left.dependencyName.localeCompare(
    right.dependencyName,
  );
  return dependencyDifference === 0
    ? left.sectionName.localeCompare(right.sectionName)
    : dependencyDifference;
}

export function collectWorkspaceDependencyDeclarations(
  context: ValidatedWorkspaceContext,
): WorkspaceDependencyDeclaration[] {
  const namedWorkspacePackages = context.packages.filter(
    isNamedWorkspacePackage,
  );
  const workspacePackageIdentities = new Map(
    namedWorkspacePackages.map((entry) => [
      entry.name,
      getPackageOwnerIdentity(context, entry.directory),
    ]),
  );
  return context.packages
    .flatMap((importer) =>
      collectImporterDeclarations(
        importer,
        getPackageOwnerIdentity(context, importer.directory),
        workspacePackageIdentities,
      ),
    )
    .sort(compareWorkspaceDeclarations);
}

export function isDependencyAuthorized(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return collectDependencyDeclarations(manifest, packageName).length > 0;
}
