import {
  type NamedWorkspacePackage,
  type PackageManifest,
  readJsonFile,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type { NearestPackageInfo } from '../../packages/owners';
import type { WorkspaceLookupRegion } from './region';
import {
  getManifestPackageName,
  isNodeModulesPackageRoot,
  isNodeModulesPath,
  setCachedPackageInfo,
} from './shared';
import type { NearestPackageLookupOptions, PackageLookupBounds } from './types';

type DirectoryCandidate =
  | { kind: 'continue' }
  | { kind: 'resolved'; value: NearestPackageInfo | null };

export class WorkspacePackageScopeLookup {
  readonly #namedPackagesByName: ReadonlyMap<string, NamedWorkspacePackage>;
  readonly #nearestNamedPackageInfoByDirectory = new Map<
    string,
    NearestPackageInfo | null
  >();
  readonly #nearestPackageScopeInfoByDirectory = new Map<
    string,
    NearestPackageInfo | null
  >();
  readonly #packageInfoByPackageJsonPath = new Map<
    string,
    NearestPackageInfo
  >();
  readonly #packagesByPackageJsonPath: ReadonlyMap<string, WorkspacePackage>;
  readonly #region: WorkspaceLookupRegion;

  constructor(options: {
    namedPackagesByName: ReadonlyMap<string, NamedWorkspacePackage>;
    packagesByPackageJsonPath: ReadonlyMap<string, WorkspacePackage>;
    region: WorkspaceLookupRegion;
  }) {
    this.#namedPackagesByName = options.namedPackagesByName;
    this.#packagesByPackageJsonPath = options.packagesByPackageJsonPath;
    this.#region = options.region;
  }

  findNearestPackageScopeInfo(filePath: string): NearestPackageInfo | null {
    const directory = normalizeAbsolutePath(
      path.dirname(normalizeAbsolutePath(filePath)),
    );
    return this.#findNearestPackageInfoFromDirectory(directory, {
      requireNamedPackageOrNodeModulesPackage: false,
    });
  }

  findNearestNamedPackageInfo(directory: string): NearestPackageInfo | null {
    return this.#findNearestPackageInfoFromDirectory(directory, {
      requireNamedPackageOrNodeModulesPackage: true,
    });
  }

  findWorkspacePackageForInfo(
    packageInfo: NearestPackageInfo,
  ): WorkspacePackage | null {
    const byPath = this.#packagesByPackageJsonPath.get(
      packageInfo.packageJsonPath,
    );
    if (byPath !== undefined) {
      return byPath;
    }

    return this.#findNamedPackage(packageInfo.name);
  }

  #findNamedPackage(name: string | undefined): WorkspacePackage | null {
    if (name === undefined) {
      return null;
    }

    return this.#namedPackagesByName.get(name) ?? null;
  }

  #findNearestPackageInfoFromDirectory(
    directory: string,
    options: NearestPackageLookupOptions,
  ): NearestPackageInfo | null {
    const cache = options.requireNamedPackageOrNodeModulesPackage
      ? this.#nearestNamedPackageInfoByDirectory
      : this.#nearestPackageScopeInfoByDirectory;
    const startDirectory = normalizeAbsolutePath(directory);
    const bounds = this.#createLookupBounds(startDirectory);

    if (!this.#hasLookupScope(bounds)) {
      cache.set(startDirectory, null);
      return null;
    }

    return this.#searchDirectories({
      bounds,
      cache,
      options,
      startDirectory,
    });
  }

  #searchDirectories(options: {
    bounds: PackageLookupBounds;
    cache: Map<string, NearestPackageInfo | null>;
    options: NearestPackageLookupOptions;
    startDirectory: string;
  }): NearestPackageInfo | null {
    const visited: string[] = [];

    for (const directory of this.#collectSearchDirectories(
      options.startDirectory,
      options.bounds,
    )) {
      const candidate = this.#resolveDirectoryCandidate({
        bounds: options.bounds,
        cache: options.cache,
        directory,
        options: options.options,
      });
      visited.push(directory);
      if (candidate.kind === 'resolved') {
        setCachedPackageInfo(options.cache, visited, candidate.value);
        return candidate.value;
      }
    }

    setCachedPackageInfo(options.cache, visited, null);
    return null;
  }

  #collectSearchDirectories(
    startDirectory: string,
    bounds: PackageLookupBounds,
  ): string[] {
    const directories: string[] = [];
    let current = startDirectory;

    while (true) {
      directories.push(current);
      if (this.#isSearchBoundary(current, bounds)) {
        return directories;
      }
      current = path.dirname(current);
    }
  }

  #resolveDirectoryCandidate(options: {
    bounds: PackageLookupBounds;
    cache: Map<string, NearestPackageInfo | null>;
    directory: string;
    options: NearestPackageLookupOptions;
  }): DirectoryCandidate {
    if (options.cache.has(options.directory)) {
      return {
        kind: 'resolved',
        value: options.cache.get(options.directory) ?? null,
      };
    }

    return this.#readAcceptedPackageInfo(options);
  }

  #readAcceptedPackageInfo(options: {
    bounds: PackageLookupBounds;
    directory: string;
    options: NearestPackageLookupOptions;
  }): DirectoryCandidate {
    const packageJsonPath = normalizeAbsolutePath(
      path.join(options.directory, 'package.json'),
    );
    if (!existsSync(packageJsonPath)) {
      return { kind: 'continue' };
    }

    const packageInfo = this.#readPackageInfo(packageJsonPath);
    return this.#acceptPackageInfo(packageInfo, options)
      ? { kind: 'resolved', value: packageInfo }
      : { kind: 'continue' };
  }

  #acceptPackageInfo(
    packageInfo: NearestPackageInfo,
    options: {
      bounds: PackageLookupBounds;
      directory: string;
      options: NearestPackageLookupOptions;
    },
  ): boolean {
    if (!options.options.requireNamedPackageOrNodeModulesPackage) {
      return true;
    }

    if (packageInfo.name !== undefined) {
      return true;
    }

    return this.#isAcceptedNodeModulesPackage(options);
  }

  #isAcceptedNodeModulesPackage(options: {
    bounds: PackageLookupBounds;
    directory: string;
  }): boolean {
    return (
      options.bounds.allowNodeModulesPackage &&
      isNodeModulesPackageRoot(options.directory)
    );
  }

  #createLookupBounds(directory: string): PackageLookupBounds {
    if (isNodeModulesPath(directory)) {
      return { activatedPackageRoot: null, allowNodeModulesPackage: true };
    }

    const activatedPackage = this.#region.classifyPath(directory).package;
    return activatedPackage === null
      ? { activatedPackageRoot: null, allowNodeModulesPackage: false }
      : {
          activatedPackageRoot: normalizeAbsolutePath(
            activatedPackage.directory,
          ),
          allowNodeModulesPackage: false,
        };
  }

  #hasLookupScope(bounds: PackageLookupBounds): boolean {
    return (
      bounds.activatedPackageRoot !== null || bounds.allowNodeModulesPackage
    );
  }

  #isSearchBoundary(directory: string, bounds: PackageLookupBounds): boolean {
    return (
      directory === bounds.activatedPackageRoot ||
      path.dirname(directory) === directory
    );
  }

  #readPackageInfo(packageJsonPath: string): NearestPackageInfo {
    const normalizedPath = normalizeAbsolutePath(packageJsonPath);
    const cached = this.#packageInfoByPackageJsonPath.get(normalizedPath);
    if (cached !== undefined) {
      return cached;
    }

    const manifest = readJsonFile<PackageManifest>(normalizedPath);
    const name = getManifestPackageName(manifest);
    const packageInfo = {
      directory: normalizeAbsolutePath(path.dirname(normalizedPath)),
      manifest,
      ...(name === undefined ? {} : { name }),
      packageJsonPath: normalizedPath,
    };
    this.#packageInfoByPackageJsonPath.set(normalizedPath, packageInfo);
    return packageInfo;
  }
}
