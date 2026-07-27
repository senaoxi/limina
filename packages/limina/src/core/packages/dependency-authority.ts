import type {
  NamedWorkspacePackage,
  PackageManifest,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';

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
  importer: NamedWorkspacePackage;
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
  importerName: string,
  dependencyName: string,
): string {
  return `${importerName}\0${dependencyName}`;
}

function getWorkspacePackageJsonPath(
  workspacePackage: NamedWorkspacePackage,
): string {
  return path.join(workspacePackage.directory, 'package.json');
}

function isWorkspaceDependencyCandidate(options: {
  dependencyName: string;
  importerName: string;
  workspacePackageNames: ReadonlySet<string>;
}): boolean {
  return (
    options.dependencyName !== options.importerName &&
    options.workspacePackageNames.has(options.dependencyName)
  );
}

function collectImporterSectionDeclarations(options: {
  importer: NamedWorkspacePackage;
  sectionName: DependencySectionName;
  workspacePackageNames: ReadonlySet<string>;
}): WorkspaceDependencyDeclaration[] {
  const section = getDependencySection(
    options.importer.manifest,
    options.sectionName,
  );

  if (section === null) {
    return [];
  }

  return Object.entries(section)
    .filter(([dependencyName]) =>
      isWorkspaceDependencyCandidate({
        dependencyName,
        importerName: options.importer.name,
        workspacePackageNames: options.workspacePackageNames,
      }),
    )
    .map(([dependencyName, specifier]) => ({
      dependencyName,
      importer: options.importer,
      packageJsonPath: getWorkspacePackageJsonPath(options.importer),
      sectionName: options.sectionName,
      specifier,
    }));
}

function collectImporterDeclarations(
  importer: NamedWorkspacePackage,
  workspacePackageNames: ReadonlySet<string>,
): WorkspaceDependencyDeclaration[] {
  return dependencySectionNames.flatMap((sectionName) =>
    collectImporterSectionDeclarations({
      importer,
      sectionName,
      workspacePackageNames,
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
  workspacePackages: WorkspacePackage[],
): WorkspaceDependencyDeclaration[] {
  const namedWorkspacePackages = workspacePackages.filter(
    isNamedWorkspacePackage,
  );
  const workspacePackageNames = new Set(
    namedWorkspacePackages.map((workspacePackage) => workspacePackage.name),
  );

  return namedWorkspacePackages
    .flatMap((importer) =>
      collectImporterDeclarations(importer, workspacePackageNames),
    )
    .sort(compareWorkspaceDeclarations);
}

export function isDependencyAuthorized(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return collectDependencyDeclarations(manifest, packageName).length > 0;
}
