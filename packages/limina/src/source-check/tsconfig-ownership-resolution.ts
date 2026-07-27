import type { ResolvedLiminaConfig } from '#config/runner';
import {
  getRawReferencePaths,
  isOrdinaryTypecheckConfigPath,
} from '#core/tsconfig/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type { TsconfigOwnershipResolution } from './source-types';

function isEmptyFilesArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function isReferenceOnlySolutionConfig(
  configObject: Record<string, unknown>,
): boolean {
  const conditions = [
    Object.hasOwn(configObject, 'references'),
    !Object.hasOwn(configObject, 'include'),
    !Object.hasOwn(configObject, 'files') ||
      isEmptyFilesArray(configObject.files),
  ];

  return conditions.every(Boolean);
}

function addExistingCandidate(candidates: string[], directory: string): void {
  const candidate = normalizeAbsolutePath(
    path.join(directory, 'tsconfig.json'),
  );
  if (existsSync(candidate)) {
    candidates.push(candidate);
  }
}

function getParentDirectory(
  currentDir: string,
  rootDir: string,
): string | null {
  if (currentDir === rootDir) {
    return null;
  }

  const parentDir = normalizeAbsolutePath(path.dirname(currentDir));
  return parentDir === currentDir ? null : parentDir;
}

function collectBareTsconfigPathCandidates(options: {
  filePath: string;
  rootDir: string;
}): string[] {
  const candidates: string[] = [];
  const rootDir = normalizeAbsolutePath(options.rootDir);
  let currentDir: string | null = normalizeAbsolutePath(
    path.dirname(options.filePath),
  );

  while (currentDir && isPathInsideDirectory(currentDir, rootDir)) {
    addExistingCandidate(candidates, currentDir);
    currentDir = getParentDirectory(currentDir, rootDir);
  }

  return candidates;
}

interface ReachableConfigVisit {
  acceptedPath?: string;
  references: string[];
}

function isReachableOrdinaryConfig(configPath: string): boolean {
  return existsSync(configPath) && isOrdinaryTypecheckConfigPath(configPath);
}

function visitReachableConfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  seen: Set<string>;
}): ReachableConfigVisit {
  const normalizedPath = normalizeAbsolutePath(options.configPath);
  if (options.seen.has(normalizedPath)) {
    return { references: [] };
  }

  options.seen.add(normalizedPath);
  if (!isReachableOrdinaryConfig(normalizedPath)) {
    return { references: [] };
  }

  return {
    acceptedPath: normalizedPath,
    references: getRawReferencePaths(options.config, normalizedPath),
  };
}

function collectReachableOrdinaryTypecheckConfigPaths(options: {
  config: ResolvedLiminaConfig;
  rootConfigPath: string;
}): string[] {
  const queue = getRawReferencePaths(options.config, options.rootConfigPath);
  const reachablePaths: string[] = [];
  const seen = new Set<string>();

  for (const configPath of queue) {
    const visit = visitReachableConfig({
      config: options.config,
      configPath,
      seen,
    });
    if (visit.acceptedPath) {
      reachablePaths.push(visit.acceptedPath);
    }
    queue.push(...visit.references);
  }

  return reachablePaths;
}

function collectTsconfigOwnershipMatches(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
  rootConfigPath: string;
}): string[] {
  if (options.getProjectFileSet(options.rootConfigPath).has(options.fileName)) {
    return [options.rootConfigPath];
  }

  return collectReachableOrdinaryTypecheckConfigPaths({
    config: options.config,
    rootConfigPath: options.rootConfigPath,
  }).filter((configPath) =>
    options.getProjectFileSet(configPath).has(options.fileName),
  );
}

function createCandidateResolution(options: {
  candidatePath: string;
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
  searchedTsconfigPaths: string[];
}): TsconfigOwnershipResolution | null {
  options.searchedTsconfigPaths.push(options.candidatePath);
  const matchedOwnerConfigPaths = collectTsconfigOwnershipMatches({
    config: options.config,
    fileName: options.fileName,
    getProjectFileSet: options.getProjectFileSet,
    rootConfigPath: options.candidatePath,
  });
  if (matchedOwnerConfigPaths.length === 0) {
    return null;
  }

  return {
    matchedOwnerConfigPaths,
    searchedTsconfigPaths: options.searchedTsconfigPaths,
    status: matchedOwnerConfigPaths.length === 1 ? 'matched' : 'multiple',
    tsconfigPath: options.candidatePath,
  };
}

function findCandidateResolution(options: {
  candidatePaths: string[];
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
  searchedTsconfigPaths: string[];
}): TsconfigOwnershipResolution | null {
  for (const candidatePath of options.candidatePaths) {
    const resolution = createCandidateResolution({
      ...options,
      candidatePath,
    });
    if (resolution) {
      return resolution;
    }
  }

  return null;
}

function createMissingOwnershipResolution(): TsconfigOwnershipResolution {
  return {
    matchedOwnerConfigPaths: [],
    searchedTsconfigPaths: [],
    status: 'missing',
    tsconfigPath: null,
  };
}

function createUnmatchedOwnershipResolution(
  searchedTsconfigPaths: string[],
): TsconfigOwnershipResolution {
  return {
    matchedOwnerConfigPaths: [],
    searchedTsconfigPaths,
    status: 'unmatched',
    tsconfigPath: searchedTsconfigPaths.at(-1) ?? null,
  };
}

export function resolveTsconfigOwnership(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
  ownerRootDir: string;
}): TsconfigOwnershipResolution {
  const candidatePaths = collectBareTsconfigPathCandidates({
    filePath: options.fileName,
    rootDir: options.ownerRootDir,
  });
  if (candidatePaths.length === 0) {
    return createMissingOwnershipResolution();
  }
  const searchedTsconfigPaths: string[] = [];
  return (
    findCandidateResolution({
      ...options,
      candidatePaths,
      searchedTsconfigPaths,
    }) ?? createUnmatchedOwnershipResolution(searchedTsconfigPaths)
  );
}
