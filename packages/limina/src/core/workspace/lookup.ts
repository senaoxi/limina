import {
  getPackageRootSpecifier,
  type ImporterInfo,
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type PackageManifest,
  type PackageOwner,
  readJsonFile,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';

import type {
  NearestPackageInfo,
  ResolvedPackageTarget,
} from '../packages/owners';
import {
  createWorkspaceActivatedRegionIndex,
  createWorkspaceRegionBoundaryIndex,
  type WorkspaceActivatedRegionIndex,
  type WorkspaceRegionBoundary,
  type WorkspaceRegionBoundaryIndex,
} from './regions';

export interface WorkspaceLookupIndexOptions {
  importers: ImporterInfo[];
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  regionBoundaries?: readonly WorkspaceRegionBoundary[];
  rootDir: string;
}

interface NormalizedImporter {
  directory: string;
  importer: ImporterInfo;
}

interface NearestPackageLookupOptions {
  requireNamedPackageOrNodeModulesPackage: boolean;
}

interface PackageLookupBounds {
  activatedPackageRoot: string | null;
  allowNodeModulesPackage: boolean;
}

export class WorkspaceLookupIndex {
  readonly rootDir: string;

  readonly #activatedRegions: WorkspaceActivatedRegionIndex;
  readonly #importers: NormalizedImporter[];
  readonly #namedPackagesByName = new Map<string, NamedWorkspacePackage>();
  readonly #ownersByDirectory: Map<string, PackageOwner>;
  readonly #packageInfoByPackageJsonPath = new Map<
    string,
    NearestPackageInfo
  >();
  readonly #packagesByDirectory: Map<string, WorkspacePackage>;
  readonly #packagesByPackageJsonPath = new Map<string, WorkspacePackage>();
  readonly #regionBoundaries: WorkspaceRegionBoundaryIndex;

  readonly #importerByFilePath = new Map<string, ImporterInfo | null>();
  readonly #nearestNamedPackageInfoByDirectory = new Map<
    string,
    NearestPackageInfo | null
  >();
  readonly #nearestPackageScopeInfoByDirectory = new Map<
    string,
    NearestPackageInfo | null
  >();
  readonly #ownerByFilePath = new Map<string, PackageOwner | null>();
  readonly #packageByFilePath = new Map<string, WorkspacePackage | null>();
  readonly #resolvedPackageTargetByKey = new Map<
    string,
    ResolvedPackageTarget
  >();

  constructor(options: WorkspaceLookupIndexOptions) {
    this.rootDir = normalizeAbsolutePath(options.rootDir);
    this.#regionBoundaries = createWorkspaceRegionBoundaryIndex(
      options.regionBoundaries ?? [],
      options.packages,
    );
    this.#activatedRegions = createWorkspaceActivatedRegionIndex({
      boundaries: options.regionBoundaries ?? [],
      packages: options.packages,
      rootDir: this.rootDir,
    });
    this.#importers = options.importers
      .filter(
        (importer) =>
          this.#isInsideActivatedRegion(importer.directory) &&
          !this.#regionBoundaries.isInsideBoundary(importer.directory),
      )
      .map((importer) => ({
        directory: normalizeAbsolutePath(importer.directory),
        importer,
      }));
    this.#ownersByDirectory = createDirectoryMap(
      options.owners.filter(
        (owner) =>
          this.#isInsideActivatedRegion(owner.directory) &&
          !this.#regionBoundaries.isInsideBoundary(owner.directory),
      ),
    );
    const currentRegionPackages = options.packages.filter(
      (workspacePackage) =>
        this.#isInsideActivatedRegion(workspacePackage.directory) &&
        !this.#regionBoundaries.isInsideBoundary(workspacePackage.directory),
    );

    this.#packagesByDirectory = createDirectoryMap(currentRegionPackages);

    for (const workspacePackage of currentRegionPackages) {
      const packageJsonPath = normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      );

      this.#packagesByPackageJsonPath.set(packageJsonPath, workspacePackage);

      if (
        isNamedWorkspacePackage(workspacePackage) &&
        !this.#namedPackagesByName.has(workspacePackage.name)
      ) {
        this.#namedPackagesByName.set(workspacePackage.name, workspacePackage);
      }
    }
  }

  findPackageForFile(filePath: string): WorkspacePackage | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = this.#packageByFilePath.get(normalizedFilePath);

    if (cached !== undefined) {
      return cached;
    }

    const workspacePackage = this.#isOutsideGovernedRegion(normalizedFilePath)
      ? null
      : findNearestDirectoryItem(normalizedFilePath, this.#packagesByDirectory);

    this.#packageByFilePath.set(normalizedFilePath, workspacePackage);
    return workspacePackage;
  }

  findOwnerForFile(filePath: string): PackageOwner | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = this.#ownerByFilePath.get(normalizedFilePath);

    if (cached !== undefined) {
      return cached;
    }

    const owner = this.#isOutsideGovernedRegion(normalizedFilePath)
      ? null
      : findNearestDirectoryItem(normalizedFilePath, this.#ownersByDirectory);

    this.#ownerByFilePath.set(normalizedFilePath, owner);
    return owner;
  }

  findImporterForFile(filePath: string): ImporterInfo | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = this.#importerByFilePath.get(normalizedFilePath);

    if (cached !== undefined) {
      return cached;
    }

    const importer = this.#isOutsideGovernedRegion(normalizedFilePath)
      ? null
      : (this.#importers.find((candidate) =>
          isPathInsideNormalizedDirectory(
            normalizedFilePath,
            candidate.directory,
          ),
        )?.importer ?? null);

    this.#importerByFilePath.set(normalizedFilePath, importer);
    return importer;
  }

  findNearestPackageScopeInfo(filePath: string): NearestPackageInfo | null {
    const directory = normalizeAbsolutePath(
      path.dirname(normalizeAbsolutePath(filePath)),
    );

    return this.#findNearestPackageInfoFromDirectory(directory, {
      requireNamedPackageOrNodeModulesPackage: false,
    });
  }

  isInsideActivatedRegion(filePath: string): boolean {
    const normalizedFilePath = normalizeAbsolutePath(filePath);

    return !this.#isOutsideGovernedRegion(normalizedFilePath);
  }

  isLocalPathOutsideActivatedRegion(filePath: string): boolean {
    const normalizedFilePath = normalizeAbsolutePath(filePath);

    return (
      isPathInsideDirectory(normalizedFilePath, this.rootDir) &&
      !this.#isInsideNodeModules(normalizedFilePath) &&
      !this.#isInsideActivatedRegion(normalizedFilePath)
    );
  }

  findPackageForSpecifier(specifier: string): NamedWorkspacePackage | null {
    return (
      this.#namedPackagesByName.get(getPackageRootSpecifier(specifier)) ?? null
    );
  }

  classifyResolvedPackageTarget(options: {
    owner: PackageOwner;
    resolvedFilePath: string;
  }): ResolvedPackageTarget {
    const normalizedResolvedFilePath = normalizeAbsolutePath(
      options.resolvedFilePath,
    );
    const cacheKey = `${options.owner.packageJsonPath}\0${normalizedResolvedFilePath}`;
    const cached = this.#resolvedPackageTargetByKey.get(cacheKey);

    if (cached) {
      return cached;
    }

    const packageInfo = this.#findNearestPackageInfoFromDirectory(
      normalizeAbsolutePath(path.dirname(normalizedResolvedFilePath)),
      {
        requireNamedPackageOrNodeModulesPackage: true,
      },
    );
    const targetOwner = this.findOwnerForFile(normalizedResolvedFilePath);
    const target = this.#classifyResolvedPackageTarget({
      owner: options.owner,
      packageInfo,
      targetOwner,
    });

    this.#resolvedPackageTargetByKey.set(cacheKey, target);
    return target;
  }

  #classifyResolvedPackageTarget(options: {
    owner: PackageOwner;
    packageInfo: NearestPackageInfo | null;
    targetOwner: PackageOwner | null;
  }): ResolvedPackageTarget {
    if (!options.packageInfo) {
      if (
        options.targetOwner?.packageJsonPath === options.owner.packageJsonPath
      ) {
        return {
          kind: 'current-owner',
          packageInfo: {
            directory: options.owner.directory,
            manifest: options.owner.manifest,
            ...(options.owner.name ? { name: options.owner.name } : {}),
            packageJsonPath: options.owner.packageJsonPath,
          },
        };
      }

      return {
        kind: 'unowned',
      };
    }

    if (
      options.targetOwner?.packageJsonPath === options.owner.packageJsonPath &&
      !isPackageInfoInsideNodeModules(options.packageInfo)
    ) {
      return {
        kind: 'current-owner',
        packageInfo: options.packageInfo,
      };
    }

    if (
      options.targetOwner &&
      options.targetOwner.packageJsonPath !== options.owner.packageJsonPath
    ) {
      return {
        kind: 'other-owner',
        packageInfo: options.packageInfo,
        targetOwner: options.targetOwner,
        workspacePackage: this.#findWorkspacePackageForPackageInfo(
          options.packageInfo,
        ),
      };
    }

    return {
      kind: 'artifact-package',
      packageInfo: options.packageInfo,
    };
  }

  #findNearestPackageInfoFromDirectory(
    directory: string,
    options: NearestPackageLookupOptions,
  ): NearestPackageInfo | null {
    const cache = options.requireNamedPackageOrNodeModulesPackage
      ? this.#nearestNamedPackageInfoByDirectory
      : this.#nearestPackageScopeInfoByDirectory;
    const visitedDirectories: string[] = [];
    let currentDir = normalizeAbsolutePath(directory);
    const bounds = this.#createPackageLookupBounds(currentDir);

    if (!bounds.activatedPackageRoot && !bounds.allowNodeModulesPackage) {
      cache.set(currentDir, null);
      return null;
    }

    while (true) {
      const cached = cache.get(currentDir);

      if (cached !== undefined) {
        setCachedPackageInfo(cache, visitedDirectories, cached);
        return cached;
      }

      visitedDirectories.push(currentDir);

      const packageJsonPath = normalizeAbsolutePath(
        path.join(currentDir, 'package.json'),
      );

      if (existsSync(packageJsonPath)) {
        const packageInfo = this.#readPackageInfo(packageJsonPath);

        if (
          !options.requireNamedPackageOrNodeModulesPackage ||
          packageInfo.name ||
          (bounds.allowNodeModulesPackage &&
            isNodeModulesPackageRoot(currentDir))
        ) {
          setCachedPackageInfo(cache, visitedDirectories, packageInfo);
          return packageInfo;
        }
      }

      if (bounds.activatedPackageRoot === currentDir) {
        setCachedPackageInfo(cache, visitedDirectories, null);
        return null;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        setCachedPackageInfo(cache, visitedDirectories, null);
        return null;
      }

      currentDir = parentDir;
    }
  }

  #createPackageLookupBounds(directory: string): PackageLookupBounds {
    if (this.#isInsideNodeModules(directory)) {
      return {
        activatedPackageRoot: null,
        allowNodeModulesPackage: true,
      };
    }

    const activatedPackage =
      this.#activatedRegions.findPackageForPath(directory);

    if (activatedPackage) {
      return {
        activatedPackageRoot: normalizeAbsolutePath(activatedPackage.directory),
        allowNodeModulesPackage: false,
      };
    }

    return {
      activatedPackageRoot: null,
      allowNodeModulesPackage: this.#isInsideNodeModules(directory),
    };
  }

  #findWorkspacePackageForPackageInfo(
    packageInfo: NearestPackageInfo,
  ): WorkspacePackage | null {
    return (
      this.#packagesByPackageJsonPath.get(packageInfo.packageJsonPath) ??
      (packageInfo.name
        ? this.#namedPackagesByName.get(packageInfo.name)
        : undefined) ??
      null
    );
  }

  #readPackageInfo(packageJsonPath: string): NearestPackageInfo {
    const normalizedPackageJsonPath = normalizeAbsolutePath(packageJsonPath);
    const cached = this.#packageInfoByPackageJsonPath.get(
      normalizedPackageJsonPath,
    );

    if (cached) {
      return cached;
    }

    const directory = normalizeAbsolutePath(path.dirname(packageJsonPath));
    const manifest = readJsonFile<PackageManifest>(normalizedPackageJsonPath);
    const name = getManifestPackageName(manifest);
    const packageInfo = {
      directory,
      manifest,
      ...(name ? { name } : {}),
      packageJsonPath: normalizedPackageJsonPath,
    };

    this.#packageInfoByPackageJsonPath.set(
      normalizedPackageJsonPath,
      packageInfo,
    );
    return packageInfo;
  }

  #isInsideActivatedRegion(filePath: string): boolean {
    return this.#activatedRegions.isInsideActivatedRegion(filePath);
  }

  #isInsideNodeModules(filePath: string): boolean {
    return normalizeAbsolutePath(filePath).split('/').includes('node_modules');
  }

  #isOutsideGovernedRegion(filePath: string): boolean {
    return (
      this.#regionBoundaries.isInsideBoundary(filePath) ||
      this.#isInsideNodeModules(filePath) ||
      !this.#isInsideActivatedRegion(filePath)
    );
  }
}

export function createWorkspaceLookupIndex(
  options: WorkspaceLookupIndexOptions,
): WorkspaceLookupIndex {
  return new WorkspaceLookupIndex(options);
}

function createDirectoryMap<T extends { directory: string }>(
  items: T[],
): Map<string, T> {
  const itemsByDirectory = new Map<string, T>();

  for (const item of items) {
    const directory = normalizeAbsolutePath(item.directory);

    if (!itemsByDirectory.has(directory)) {
      itemsByDirectory.set(directory, item);
    }
  }

  return itemsByDirectory;
}

function findNearestDirectoryItem<T>(
  filePath: string,
  itemsByDirectory: Map<string, T>,
): T | null {
  let currentDir = normalizeAbsolutePath(filePath);
  const exactMatch = itemsByDirectory.get(currentDir);

  if (exactMatch) {
    return exactMatch;
  }

  currentDir = normalizeAbsolutePath(path.dirname(currentDir));

  while (true) {
    const item = itemsByDirectory.get(currentDir);

    if (item) {
      return item;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function getManifestPackageName(manifest: PackageManifest): string | undefined {
  return typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim()
    : undefined;
}

function isNodeModulesPackageRoot(directory: string): boolean {
  const parentDirectory = path.dirname(directory);
  const parentName = path.basename(parentDirectory);

  if (parentName === 'node_modules') {
    return true;
  }

  if (parentName.startsWith('@')) {
    return path.basename(path.dirname(parentDirectory)) === 'node_modules';
  }

  return false;
}

function isPackageInfoInsideNodeModules(
  packageInfo: NearestPackageInfo,
): boolean {
  return normalizeAbsolutePath(packageInfo.directory)
    .split('/')
    .includes('node_modules');
}

function isPathInsideNormalizedDirectory(
  normalizedFilePath: string,
  normalizedDirectoryPath: string,
): boolean {
  const directoryPrefix = normalizedDirectoryPath.endsWith('/')
    ? normalizedDirectoryPath
    : `${normalizedDirectoryPath}/`;

  return (
    normalizedFilePath === normalizedDirectoryPath ||
    normalizedFilePath.startsWith(directoryPrefix)
  );
}

function setCachedPackageInfo(
  cache: Map<string, NearestPackageInfo | null>,
  directories: string[],
  packageInfo: NearestPackageInfo | null,
): void {
  for (const directory of directories) {
    cache.set(directory, packageInfo);
  }
}
