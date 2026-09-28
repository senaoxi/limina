import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import type {
  WorkspacePathClassification,
  WorkspaceRegionPathIndex,
} from '../validated-context';
import { isNodeModulesPath } from './shared';

export class WorkspaceLookupRegion {
  readonly rootDir: string;
  readonly #pathIndex: WorkspaceRegionPathIndex;

  constructor(rootDir: string, pathIndex: WorkspaceRegionPathIndex) {
    this.rootDir = normalizeAbsolutePath(rootDir);
    this.#pathIndex = pathIndex;
  }

  classifyPath(filePath: string): WorkspacePathClassification {
    return this.#pathIndex.classifyPath(normalizeAbsolutePath(filePath));
  }

  hasActivatedPackage(filePath: string): boolean {
    return Boolean(this.classifyPath(filePath).package);
  }

  isInsideActivatedRegion(filePath: string): boolean {
    return !this.isOutsideGovernedRegion(filePath);
  }

  isOutsideGovernedRegion(
    filePath: string,
    classification?: WorkspacePathClassification,
  ): boolean {
    if (isNodeModulesPath(filePath)) {
      return true;
    }

    return !(classification ?? this.classifyPath(filePath)).package;
  }

  isLocalPathOutsideActivatedRegion(filePath: string): boolean {
    const normalizedPath = normalizeAbsolutePath(filePath);
    if (!isPathInsideDirectory(normalizedPath, this.rootDir)) {
      return false;
    }

    return (
      !isNodeModulesPath(normalizedPath) &&
      !this.isInsideActivatedRegion(normalizedPath)
    );
  }
}
