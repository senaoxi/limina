import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import type {
  WorkspacePathClassification,
  WorkspaceRegionPathIndex,
} from '../validated-context';
import { isNodeModulesPath } from './shared';

export class WorkspaceLookupRegion {
  readonly #pathIndex: WorkspaceRegionPathIndex;

  readonly rootDir: string;

  constructor(rootDirectory: string, pathIndex: WorkspaceRegionPathIndex) {
    this.rootDir = normalizeAbsolutePath(rootDirectory);
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
    return (
      isNodeModulesPath(filePath) ||
      !(classification ?? this.classifyPath(filePath)).package
    );
  }

  isLocalPathOutsideActivatedRegion(filePath: string): boolean {
    const normalizedPath = normalizeAbsolutePath(filePath);
    return (
      isPathInsideDirectory(normalizedPath, this.rootDir) &&
      !isNodeModulesPath(normalizedPath) &&
      !this.isInsideActivatedRegion(normalizedPath)
    );
  }
}
