import { normalizeSlashes } from '#utils/path';
import path from 'pathe';
import rawPicomatch from 'picomatch';

export type PathFilterCandidateKind = 'file' | 'package-manifest';

export interface PathFilterCandidate {
  kind: PathFilterCandidateKind;
  path: string;
  /**
  Additional path roots used only for scope matching.
  */
  scopeRelativeTo?: readonly string[];
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}()!+]/u.test(value);
}

function normalizeRelativePath(value: string): string {
  const normalized = normalizeSlashes(path.normalize(normalizeSlashes(value)));
  return normalized === '' ? '.' : normalized;
}

function normalizeCandidatePath(
  candidatePath: string,
  rootDirectory?: string,
): string {
  const normalizedPath = normalizeSlashes(candidatePath);

  if (!rootDirectory) {
    return normalizeRelativePath(normalizedPath);
  }

  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(rootDirectory, normalizedPath);
  return normalizeRelativePath(path.relative(rootDirectory, absolutePath));
}

function normalizeFilterPath(value: string, rootDirectory?: string): string {
  const normalizedValue = normalizeSlashes(value.trim());

  return normalizeRelativePath(
    rootDirectory && path.isAbsolute(normalizedValue)
      ? path.relative(rootDirectory, normalizedValue)
      : normalizedValue,
  );
}

function getScopeRoots(candidate: PathFilterCandidate): readonly string[] {
  return candidate.scopeRelativeTo || [];
}

function resolveAbsoluteCandidatePath(
  candidatePath: string,
  rootDirectory: string | undefined,
): string | undefined {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }

  return rootDirectory === undefined
    ? undefined
    : path.resolve(rootDirectory, candidatePath);
}

function getAlternativeScopePaths(
  candidate: PathFilterCandidate,
  rootDirectory: string | undefined,
): string[] {
  const scopeRoots = getScopeRoots(candidate);
  if (scopeRoots.length === 0) {
    return [];
  }

  const absolutePath = resolveAbsoluteCandidatePath(
    candidate.path,
    rootDirectory,
  );
  return absolutePath === undefined
    ? []
    : scopeRoots.map((baseDirectory) =>
        normalizeRelativePath(path.relative(baseDirectory, absolutePath)),
      );
}

function getScopeCandidatePaths(
  candidate: PathFilterCandidate,
  rootDirectory?: string,
): string[] {
  const rootRelativePath = normalizeCandidatePath(
    candidate.path,
    rootDirectory,
  );
  const alternativePaths = getAlternativeScopePaths(candidate, rootDirectory);

  return [...new Set([rootRelativePath, ...alternativePaths])];
}

function isPathMatchesPlainScope(
  candidatePath: string,
  scope: string,
): boolean {
  return (
    candidatePath === scope ||
    (scope === '.'
      ? !candidatePath.startsWith('../')
      : candidatePath.startsWith(`${scope}/`))
  );
}

function isCandidateMatchesScope(
  candidate: PathFilterCandidate,
  scope: string,
  rootDirectory?: string,
): boolean {
  const normalizedScope = normalizeFilterPath(scope, rootDirectory);
  const candidatePaths = getScopeCandidatePaths(candidate, rootDirectory);

  if (!hasGlobSyntax(normalizedScope)) {
    return candidatePaths.some((candidatePath) =>
      isPathMatchesPlainScope(candidatePath, normalizedScope),
    );
  }

  const matches = picomatch(normalizedScope, {
    dot: true,
    posixSlashes: true,
  });
  return candidatePaths.some((candidatePath) => matches(candidatePath));
}

export function isPathCandidatesMatchFileFilters(options: {
  candidates: readonly PathFilterCandidate[];
  files: readonly string[];
  rootDir?: string;
}): boolean {
  const selectedFiles = new Set(
    options.files.map((filePath) =>
      normalizeFilterPath(filePath, options.rootDir),
    ),
  );

  return options.candidates.some((candidate) =>
    selectedFiles.has(normalizeCandidatePath(candidate.path, options.rootDir)),
  );
}

export function isPathCandidatesMatchScopeFilters(options: {
  candidates: readonly PathFilterCandidate[];
  rootDir?: string;
  scopes: readonly string[];
}): boolean {
  return options.scopes.some((scope) =>
    options.candidates.some((candidate) =>
      isCandidateMatchesScope(candidate, scope, options.rootDir),
    ),
  );
}
