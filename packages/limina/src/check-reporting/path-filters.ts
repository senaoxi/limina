import { normalizeSlashes } from '#utils/path';
import path from 'pathe';
import rawPicomatch from 'picomatch';

export type PathFilterCandidateKind = 'file' | 'package-manifest';

export interface PathFilterCandidate {
  kind: PathFilterCandidateKind;
  path: string;
  /** Additional path roots used only for scope matching. */
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
  rootDir?: string,
): string {
  const normalizedPath = normalizeSlashes(candidatePath);

  if (!rootDir) {
    return normalizeRelativePath(normalizedPath);
  }

  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(rootDir, normalizedPath);
  return normalizeRelativePath(path.relative(rootDir, absolutePath));
}

function normalizeFilterPath(value: string, rootDir?: string): string {
  const normalizedValue = normalizeSlashes(value.trim());

  if (rootDir && path.isAbsolute(normalizedValue)) {
    return normalizeRelativePath(path.relative(rootDir, normalizedValue));
  }

  return normalizeRelativePath(normalizedValue);
}

function getScopeCandidatePaths(
  candidate: PathFilterCandidate,
  rootDir?: string,
): string[] {
  const rootRelativePath = normalizeCandidatePath(candidate.path, rootDir);

  if (!candidate.scopeRelativeTo?.length) {
    return [rootRelativePath];
  }

  const absoluteCandidatePath = path.isAbsolute(candidate.path)
    ? candidate.path
    : rootDir
      ? path.resolve(rootDir, candidate.path)
      : undefined;
  const alternativePaths = absoluteCandidatePath
    ? candidate.scopeRelativeTo.map((baseDir) =>
        normalizeRelativePath(path.relative(baseDir, absoluteCandidatePath)),
      )
    : [];

  return [...new Set([rootRelativePath, ...alternativePaths])];
}

function pathMatchesPlainScope(candidatePath: string, scope: string): boolean {
  return (
    candidatePath === scope ||
    (scope === '.'
      ? !candidatePath.startsWith('../')
      : candidatePath.startsWith(`${scope}/`))
  );
}

function candidateMatchesScope(
  candidate: PathFilterCandidate,
  scope: string,
  rootDir?: string,
): boolean {
  const normalizedScope = normalizeFilterPath(scope, rootDir);
  const candidatePaths = getScopeCandidatePaths(candidate, rootDir);

  if (!hasGlobSyntax(normalizedScope)) {
    return candidatePaths.some((candidatePath) =>
      pathMatchesPlainScope(candidatePath, normalizedScope),
    );
  }

  const matches = picomatch(normalizedScope, {
    dot: true,
    posixSlashes: true,
  });
  return candidatePaths.some((candidatePath) => matches(candidatePath));
}

export function pathCandidatesMatchFileFilters(options: {
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

export function pathCandidatesMatchScopeFilters(options: {
  candidates: readonly PathFilterCandidate[];
  rootDir?: string;
  scopes: readonly string[];
}): boolean {
  return options.scopes.some((scope) =>
    options.candidates.some((candidate) =>
      candidateMatchesScope(candidate, scope, options.rootDir),
    ),
  );
}
