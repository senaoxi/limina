import { normalizeSlashes, toRelativePath } from '#utils/path';
import path from 'pathe';
import type { LiminaCheckIssue, LiminaCheckIssueLocation } from './snapshot';

function stripLineColumnSuffix(filePath: string): string {
  return filePath.replace(/:\d+(?::\d+)?(?:\s+\(.+\))?$/u, '');
}

function prepareIssuePath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const trimmedPath = stripLineColumnSuffix(filePath.trim());
  return trimmedPath.length > 0 ? trimmedPath : undefined;
}

function makeIssuePathRelative(rootDir: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? toRelativePath(rootDir, filePath)
    : filePath.replaceAll(/^\.\//gu, '');
}

export function normalizeCheckIssuePath(
  rootDir: string,
  filePath: string | undefined,
): string | undefined {
  const preparedPath = prepareIssuePath(filePath);

  return preparedPath === undefined
    ? undefined
    : normalizeSlashes(makeIssuePathRelative(rootDir, preparedPath));
}

function findLocationFilePath(
  locations: readonly LiminaCheckIssueLocation[] | undefined,
): string | undefined {
  return locations?.find((location) => location.filePath)?.filePath;
}

function findLocationManifestPath(
  locations: readonly LiminaCheckIssueLocation[] | undefined,
): string | undefined {
  return locations?.find((location) => location.packageManifestPath)
    ?.packageManifestPath;
}

function firstDefined(
  values: readonly (string | undefined)[],
): string | undefined {
  return values.find((value) => value !== undefined);
}

function normalizeScopeDirectory(locationPath: string): string {
  const directory = path.posix.dirname(locationPath);
  return directory === '.' ? '.' : directory;
}

export function deriveCheckIssueScope(
  issue: Pick<
    LiminaCheckIssue,
    'filePath' | 'locations' | 'packageManifestPath' | 'scope'
  >,
): string | undefined {
  const locationPath = firstDefined([
    issue.scope,
    issue.filePath,
    findLocationFilePath(issue.locations),
    issue.packageManifestPath,
    findLocationManifestPath(issue.locations),
  ]);

  if (locationPath === undefined) {
    return undefined;
  }

  if (issue.scope !== undefined) {
    return issue.scope;
  }

  return normalizeScopeDirectory(locationPath);
}

function normalizeOptionalScope(scope: string | undefined): string | undefined {
  return scope === undefined ? undefined : normalizeSlashes(scope);
}

export function normalizeCheckIssueLocation(
  rootDir: string,
  location: LiminaCheckIssueLocation,
): LiminaCheckIssueLocation {
  return {
    ...location,
    filePath: normalizeCheckIssuePath(rootDir, location.filePath),
    packageManifestPath: normalizeCheckIssuePath(
      rootDir,
      location.packageManifestPath,
    ),
    scope: normalizeOptionalScope(location.scope),
  };
}
