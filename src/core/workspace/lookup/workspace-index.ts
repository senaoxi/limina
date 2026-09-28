import {
  getPackageRootSpecifier,
  type ImporterInfo,
  type NamedWorkspacePackage,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import type {
  NearestPackageInfo,
  ResolvedPackageTarget,
} from '../../packages/owners';
import type { WorkspaceLookupState } from './index-state';
import { createWorkspaceLookupState } from './index-state';
import type { WorkspaceLookupIndexOptions } from './types';

export class WorkspaceLookupIndex {
  readonly rootDir: string;
  readonly #state: WorkspaceLookupState;

  constructor(options: WorkspaceLookupIndexOptions) {
    this.#state = createWorkspaceLookupState(options);
    this.rootDir = this.#state.region.rootDir;
  }

  findPackageForFile(filePath: string): WorkspacePackage | null {
    return this.#state.packageLookup.find(filePath);
  }

  findOwnerForFile(filePath: string): PackageOwner | null {
    return this.#state.ownerLookup.find(filePath);
  }

  findImporterForFile(filePath: string): ImporterInfo | null {
    return this.#state.importerLookup.find(filePath);
  }

  findNearestPackageScopeInfo(filePath: string): NearestPackageInfo | null {
    return this.#state.packageScopeLookup.findNearestPackageScopeInfo(filePath);
  }

  isInsideActivatedRegion(filePath: string): boolean {
    return this.#state.region.isInsideActivatedRegion(filePath);
  }

  isLocalPathOutsideActivatedRegion(filePath: string): boolean {
    return this.#state.region.isLocalPathOutsideActivatedRegion(filePath);
  }

  findPackageForSpecifier(specifier: string): NamedWorkspacePackage | null {
    return (
      this.#state.namedPackagesByName.get(getPackageRootSpecifier(specifier)) ??
      null
    );
  }

  classifyResolvedPackageTarget(options: {
    owner: PackageOwner;
    resolvedFilePath: string;
  }): ResolvedPackageTarget {
    return this.#state.targetLookup.classify(options);
  }
}

export function createWorkspaceLookupIndex(
  options: WorkspaceLookupIndexOptions,
): WorkspaceLookupIndex {
  return new WorkspaceLookupIndex(options);
}
