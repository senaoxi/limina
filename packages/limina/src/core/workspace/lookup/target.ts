import type { PackageOwner } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type {
  NearestPackageInfo,
  ResolvedPackageTarget,
} from '../../packages/owners';
import type { WorkspaceIndexMetricsRecorder } from '../validated-context';
import type { GovernedDirectoryLookup } from './directory';
import type { WorkspacePackageScopeLookup } from './package-scope';
import { isPackageInfoInsideNodeModules, recordLookupMetric } from './shared';

function toCurrentOwnerPackageInfo(owner: PackageOwner): NearestPackageInfo {
  return {
    directory: owner.directory,
    manifest: owner.manifest,
    ...(owner.name === undefined ? {} : { name: owner.name }),
    packageJsonPath: owner.packageJsonPath,
  };
}

function isSameOwner(
  owner: PackageOwner,
  targetOwner: PackageOwner | null,
): boolean {
  return targetOwner?.packageJsonPath === owner.packageJsonPath;
}

function classifyWithoutPackageInfo(options: {
  owner: PackageOwner;
  targetOwner: PackageOwner | null;
}): ResolvedPackageTarget {
  return isSameOwner(options.owner, options.targetOwner)
    ? {
        kind: 'current-owner',
        packageInfo: toCurrentOwnerPackageInfo(options.owner),
      }
    : { kind: 'unowned' };
}

function isCurrentOwnerSourceTarget(options: {
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
  targetOwner: PackageOwner | null;
}): boolean {
  if (!isSameOwner(options.owner, options.targetOwner)) {
    return false;
  }

  return !isPackageInfoInsideNodeModules(options.packageInfo);
}

export class ResolvedPackageTargetLookup {
  readonly #cache = new Map<string, ResolvedPackageTarget>();
  readonly #metrics: WorkspaceIndexMetricsRecorder | undefined;
  readonly #ownerLookup: GovernedDirectoryLookup<PackageOwner>;
  readonly #packageScopeLookup: WorkspacePackageScopeLookup;

  constructor(options: {
    metrics: WorkspaceIndexMetricsRecorder | undefined;
    ownerLookup: GovernedDirectoryLookup<PackageOwner>;
    packageScopeLookup: WorkspacePackageScopeLookup;
  }) {
    this.#metrics = options.metrics;
    this.#ownerLookup = options.ownerLookup;
    this.#packageScopeLookup = options.packageScopeLookup;
  }

  classify(options: {
    owner: PackageOwner;
    resolvedFilePath: string;
  }): ResolvedPackageTarget {
    const normalizedPath = normalizeAbsolutePath(options.resolvedFilePath);
    const cacheKey = `${options.owner.packageJsonPath}\0${normalizedPath}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#record('hit', cached);
      return cached;
    }

    const target = this.#classifyUncached(options.owner, normalizedPath);
    this.#cache.set(cacheKey, target);
    this.#record('miss', target);
    return target;
  }

  #classifyUncached(
    owner: PackageOwner,
    resolvedFilePath: string,
  ): ResolvedPackageTarget {
    const packageInfo = this.#packageScopeLookup.findNearestNamedPackageInfo(
      normalizeAbsolutePath(path.dirname(resolvedFilePath)),
    );
    const targetOwner = this.#ownerLookup.find(resolvedFilePath);
    if (packageInfo === null) {
      return classifyWithoutPackageInfo({ owner, targetOwner });
    }

    return this.#classifyWithPackageInfo({
      owner,
      packageInfo,
      targetOwner,
    });
  }

  #classifyWithPackageInfo(options: {
    owner: PackageOwner;
    packageInfo: NearestPackageInfo;
    targetOwner: PackageOwner | null;
  }): ResolvedPackageTarget {
    if (isCurrentOwnerSourceTarget(options)) {
      return { kind: 'current-owner', packageInfo: options.packageInfo };
    }

    if (options.targetOwner === null) {
      return { kind: 'artifact-package', packageInfo: options.packageInfo };
    }

    return {
      kind: 'other-owner',
      packageInfo: options.packageInfo,
      targetOwner: options.targetOwner,
      workspacePackage: this.#packageScopeLookup.findWorkspacePackageForInfo(
        options.packageInfo,
      ),
    };
  }

  #record(state: 'hit' | 'miss', value: ResolvedPackageTarget): void {
    recordLookupMetric({
      kind: 'resolved-package-target',
      metrics: this.#metrics,
      state,
      value,
    });
  }
}
