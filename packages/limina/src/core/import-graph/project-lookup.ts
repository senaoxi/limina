import {
  findPackageForSpecifier,
  type ImporterInfo,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { ProjectInfo } from './project-types';

function compareOwningProjectPaths(left: string, right: string): number {
  const depthOrder = path.dirname(right).length - path.dirname(left).length;
  return depthOrder === 0 ? left.localeCompare(right) : depthOrder;
}

function chooseOwningProject(projectPaths: readonly string[]): string {
  return [...projectPaths].sort(compareOwningProjectPaths)[0]!;
}

function comparePackageDirectories(
  left: WorkspacePackage,
  right: WorkspacePackage,
): number {
  return right.directory.length - left.directory.length;
}

export function findPackageForFile(
  filePath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    [...packages]
      .sort(comparePackageDirectories)
      .find((workspacePackage) =>
        isPathInsideDirectory(filePath, workspacePackage.directory),
      ) ?? null
  );
}

export function findImporterForFile(
  filePath: string,
  importers: ImporterInfo[],
): ImporterInfo | null {
  return (
    importers.find((importer) =>
      isPathInsideDirectory(filePath, importer.directory),
    ) ?? null
  );
}

function importerCanReachTarget(
  importer: ImporterInfo,
  targetName: string,
): boolean {
  return (
    importer.name === targetName ||
    importer.declaredWorkspaceDependencies.has(targetName)
  );
}

function getWorkspacePackageName(
  targetPackage: WorkspacePackage | null,
): string | undefined {
  return targetPackage === null ? undefined : targetPackage.name;
}

export function shouldResolveThroughGraph(
  importer: ImporterInfo | null,
  targetPackage: WorkspacePackage | null,
): boolean {
  if (importer === null) {
    return false;
  }

  const targetName = getWorkspacePackageName(targetPackage);

  if (targetName === undefined) {
    return false;
  }

  return importerCanReachTarget(importer, targetName);
}

export function formatArtifactDependencyPolicy(
  targetPackage: WorkspacePackage,
): string {
  return targetPackage.manifest.private === true
    ? 'private workspace packages cannot be consumed from a registry, so artifact consumers should use the dependency graph export with an external task tool instead of keeping a source project reference.'
    : 'artifact consumers should use the dependency graph export with an external task tool, or consume the published production package, instead of keeping a source project reference.';
}

function isPackageLibraryProject(options: {
  packageDirectory: string;
  projectPath: string;
}): boolean {
  return (
    options.projectPath.startsWith(`${options.packageDirectory}/`) &&
    options.projectPath.endsWith('/tsconfig.lib.dts.json')
  );
}

export function inferPackageProject(
  resolvedFilePath: string,
  workspacePackage: WorkspacePackage,
  projectPaths: string[],
): string | null {
  if (!isPathInsideDirectory(resolvedFilePath, workspacePackage.directory)) {
    return null;
  }

  return (
    projectPaths.find((projectPath) =>
      isPackageLibraryProject({
        packageDirectory: workspacePackage.directory,
        projectPath,
      }),
    ) ?? null
  );
}

function getProjectOwnerRootDir(project: ProjectInfo): string {
  return project.options.rootDir === undefined
    ? path.dirname(project.configPath)
    : normalizeAbsolutePath(project.options.rootDir);
}

function addFileOwner(
  ownerLookup: Map<string, string[]>,
  fileName: string,
  projectPath: string,
): void {
  const owners = ownerLookup.get(fileName) ?? [];
  owners.push(projectPath);
  ownerLookup.set(fileName, owners);
}

function addProjectFileOwners(
  ownerLookup: Map<string, string[]>,
  project: ProjectInfo,
): void {
  const ownerRootDir = getProjectOwnerRootDir(project);

  for (const fileName of project.ownedFileNames) {
    if (isPathInsideDirectory(fileName, ownerRootDir)) {
      addFileOwner(ownerLookup, fileName, project.configPath);
    }
  }
}

export function createFileOwnerLookup(
  projects: ProjectInfo[],
): Map<string, string[]> {
  const ownerLookup = new Map<string, string[]>();

  for (const project of projects) {
    addProjectFileOwners(ownerLookup, project);
  }

  return ownerLookup;
}

function hasOwnerProjects(
  ownerProjects: readonly string[] | undefined,
): ownerProjects is readonly string[] {
  return ownerProjects !== undefined && ownerProjects.length > 0;
}

export function findTargetProject(options: {
  fileOwnerLookup: Map<string, string[]>;
  packages: WorkspacePackage[];
  projectPaths: string[];
  resolvedFilePath: string;
  specifier: string;
}): string | null {
  const ownerProjects = options.fileOwnerLookup.get(options.resolvedFilePath);

  if (hasOwnerProjects(ownerProjects)) {
    return chooseOwningProject(ownerProjects);
  }

  const workspacePackage = findPackageForSpecifier(
    options.specifier,
    options.packages,
  );

  if (workspacePackage === null) {
    return null;
  }

  return inferPackageProject(
    options.resolvedFilePath,
    workspacePackage,
    options.projectPaths,
  );
}
