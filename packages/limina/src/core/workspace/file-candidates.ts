import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import rawPicomatch from 'picomatch';
import { escapePath, glob } from 'tinyglobby';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from './validated-context';

export interface WorkspaceRegionFilePathIndex {
  isInsideActivatedRegion(filePath: string): boolean;
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

/** Build fast-glob-style positive/negative filtering over known candidates. */
export function createCandidateGlobMatcher(
  patterns: readonly string[],
): (relativePath: string) => boolean {
  const positives = patterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => picomatch(pattern, { dot: true, posixSlashes: true }));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) =>
      picomatch(pattern.slice(1), { dot: true, posixSlashes: true }),
    );

  return (relativePath) =>
    positives.some((matches) => matches(relativePath)) &&
    !negatives.some((matches) => matches(relativePath));
}

/**
 * Discover files independently from every activated package island.
 *
 * Activated child roots are pruned from their parent traversal and discovered
 * by their own island job. The validated path index remains the final
 * visibility authority for owner-local boundaries and canonical identities.
 */
export async function collectActivatedPackageFileCandidates(
  context: ValidatedWorkspaceContext,
  pathIndex: WorkspaceRegionFilePathIndex = new WorkspaceRegionPathIndex(
    context,
  ),
): Promise<string[]> {
  const candidates = (
    await Promise.all(
      context.packages.map((workspacePackage) => {
        const structuralIgnores = [
          ...context.packages.map(
            (candidatePackage) => candidatePackage.directory,
          ),
          ...context.boundaries.map((boundary) => boundary.rootDir),
        ].flatMap((candidateRoot) => {
          const relativeRoot = toPosixPath(
            toRelativePath(workspacePackage.directory, candidateRoot),
          );
          return relativeRoot !== '.' &&
            !relativeRoot.startsWith('../') &&
            relativeRoot !== '..'
            ? [`${escapePath(relativeRoot)}/**`]
            : [];
        });

        return glob('**/*', {
          absolute: true,
          cwd: workspacePackage.directory,
          dot: true,
          followSymbolicLinks: false,
          ignore: [
            '**/.git/**',
            '**/.limina/**',
            '**/node_modules/**',
            ...new Set(structuralIgnores),
          ],
          onlyFiles: true,
        });
      }),
    )
  ).flat();

  return [...new Set(candidates.map(normalizeAbsolutePath))]
    .filter((filePath) => pathIndex.isInsideActivatedRegion(filePath))
    .sort((left, right) => left.localeCompare(right));
}
