import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'pathe';

const generationTokenBrand: unique symbol = Symbol(
  'ArtifactNamespaceGenerationToken',
);
const namespaceBrand: unique symbol = Symbol('LiminaArtifactNamespace');
const authenticatedNamespaces = new WeakSet<object>();
const authenticatedTokens = new WeakSet<object>();

export interface ArtifactNamespaceGenerationToken {
  readonly [generationTokenBrand]: true;
  readonly generation: number;
  readonly nonce: string;
}

export interface LiminaArtifactNamespace {
  readonly [namespaceBrand]: true;
  readonly canonicalRootDir: string;
  readonly configRootDir: string;
  readonly generation: number;
  readonly generationToken: ArtifactNamespaceGenerationToken;
  readonly rootDir: string;
}

export class ArtifactNamespaceContainmentError extends Error {
  override readonly name = 'ArtifactNamespaceContainmentError';
}

type ArtifactPathSafetyRole =
  | 'parent-directory'
  | 'target-directory'
  | 'target-file';

export interface ArtifactSafetyMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'artifact-safety-immediate-recheck'
      | 'artifact-safety-lstat'
      | 'artifact-safety-unique-node';
    readonly provider?: string;
  }): void;
}

function normalizeAbsolutePath(value: string): string {
  return path.normalize(path.resolve(value));
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function rejectUnsafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    path.isAbsolute(segment) ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
    throw new ArtifactNamespaceContainmentError(
      `Unsafe generated-artifact path segment: ${JSON.stringify(segment)}.`,
    );
  }
}

export function createLiminaArtifactNamespace(options: {
  generation: number;
  rootDir: string;
}): LiminaArtifactNamespace {
  const configRootDir = normalizeAbsolutePath(options.rootDir);
  const canonicalConfigRootDir = normalizeAbsolutePath(
    realpathSync.native(configRootDir),
  );
  const generationToken = Object.freeze({
    [generationTokenBrand]: true as const,
    generation: options.generation,
    nonce: randomUUID(),
  });
  const namespace = Object.freeze({
    [namespaceBrand]: true as const,
    canonicalRootDir: path.join(canonicalConfigRootDir, '.limina'),
    configRootDir,
    generation: options.generation,
    generationToken,
    rootDir: path.join(configRootDir, '.limina'),
  });

  authenticatedTokens.add(generationToken);
  authenticatedNamespaces.add(namespace);
  return namespace;
}

export function assertArtifactNamespaceGenerationToken(
  token: ArtifactNamespaceGenerationToken,
): void {
  if (!authenticatedTokens.has(token)) {
    throw new ArtifactNamespaceContainmentError(
      'Unauthenticated artifact namespace generation token.',
    );
  }
}

export function assertLiminaArtifactNamespace(
  namespace: LiminaArtifactNamespace,
): void {
  if (!authenticatedNamespaces.has(namespace)) {
    throw new ArtifactNamespaceContainmentError(
      'Unauthenticated Limina artifact namespace capability.',
    );
  }
  assertArtifactNamespaceGenerationToken(namespace.generationToken);
}

export function assertArtifactPathLexicallyContained(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): void {
  assertLiminaArtifactNamespace(namespace);
  if (
    !isPathInsideOrEqual(namespace.rootDir, normalizeAbsolutePath(targetPath))
  ) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact path escapes the trusted namespace: ${targetPath}.`,
    );
  }
}

export function resolveArtifactNamespacePath(
  namespace: LiminaArtifactNamespace,
  ...segments: readonly string[]
): string {
  assertLiminaArtifactNamespace(namespace);
  for (const segment of segments) rejectUnsafeSegment(segment);
  const targetPath = normalizeAbsolutePath(
    path.join(namespace.rootDir, ...segments),
  );
  assertArtifactPathLexicallyContained(namespace, targetPath);
  return targetPath;
}

export function resolveArtifactNamespaceRelativePath(
  namespace: LiminaArtifactNamespace,
  relativePath: string,
): string {
  const normalized = path.normalize(relativePath);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new ArtifactNamespaceContainmentError(
      `Unsafe generated-artifact relative path: ${JSON.stringify(relativePath)}.`,
    );
  }
  const targetPath = normalizeAbsolutePath(
    path.join(namespace.rootDir, normalized),
  );
  assertArtifactPathLexicallyContained(namespace, targetPath);
  return targetPath;
}

export function toArtifactNamespaceRelativePath(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): string {
  assertArtifactPathLexicallyContained(namespace, targetPath);
  const relativePath = path.relative(
    namespace.rootDir,
    normalizeAbsolutePath(targetPath),
  );
  if (relativePath.length === 0) {
    throw new ArtifactNamespaceContainmentError(
      'The artifact namespace root is not a file ownership entry.',
    );
  }
  return relativePath.split(path.sep).join('/');
}

export function createExternalArtifactStableId(
  rootRelativeDisplayPackageRoot: string,
): string {
  return createHash('sha256')
    .update(`v1\0${rootRelativeDisplayPackageRoot}`)
    .digest('hex');
}

async function lstatIfPresent(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertArtifactPathProjectedCanonicalContainment(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): string {
  assertArtifactPathLexicallyContained(namespace, targetPath);
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  const projectedCanonicalTarget = path.join(
    namespace.canonicalRootDir,
    path.relative(namespace.rootDir, normalizedTarget),
  );

  if (
    !isPathInsideOrEqual(
      namespace.canonicalRootDir,
      normalizeAbsolutePath(projectedCanonicalTarget),
    )
  ) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact path escapes the canonical namespace: ${targetPath}.`,
    );
  }

  return normalizedTarget;
}

function assertArtifactPathStatsSafe(
  targetPath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  roles: ReadonlySet<ArtifactPathSafetyRole>,
): void {
  if (stats.isSymbolicLink()) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact mutation crosses a symbolic link: ${targetPath}.`,
    );
  }
  if (roles.has('parent-directory') && !stats.isDirectory()) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact parent is not a directory: ${targetPath}.`,
    );
  }
  if (roles.has('target-file') && !stats.isFile()) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact target is not a regular file: ${targetPath}.`,
    );
  }
  if (roles.has('target-directory') && !stats.isDirectory()) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact target is not a directory: ${targetPath}.`,
    );
  }
}

/**
 * Validates every path in an artifact plan before the first mutation while
 * sharing checks for common namespace ancestors.
 */
export async function assertArtifactPlanPathsOperationSafe(
  namespace: LiminaArtifactNamespace,
  targetPaths: readonly string[],
  options: { metrics?: ArtifactSafetyMetricsRecorder } = {},
): Promise<void> {
  assertLiminaArtifactNamespace(namespace);
  const nodes = new Map<string, Set<ArtifactPathSafetyRole>>();
  const addRole = (targetPath: string, role: ArtifactPathSafetyRole): void => {
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    const roles = nodes.get(normalizedTarget) ?? new Set();
    roles.add(role);
    nodes.set(normalizedTarget, roles);
  };

  for (const targetPath of targetPaths) {
    const normalizedTarget = assertArtifactPathProjectedCanonicalContainment(
      namespace,
      targetPath,
    );
    addRole(namespace.rootDir, 'parent-directory');

    const relative = path.relative(namespace.rootDir, normalizedTarget);
    const segments = relative === '' ? [] : relative.split(path.sep);
    let cursor = namespace.rootDir;
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      addRole(
        cursor,
        index === segments.length - 1 ? 'target-file' : 'parent-directory',
      );
    }
    if (segments.length === 0) addRole(normalizedTarget, 'target-file');
  }

  const orderedNodes = [...nodes.entries()].sort(([left], [right]) => {
    const leftDepth = path
      .relative(namespace.rootDir, left)
      .split(path.sep)
      .filter(Boolean).length;
    const rightDepth = path
      .relative(namespace.rootDir, right)
      .split(path.sep)
      .filter(Boolean).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  options.metrics?.record({
    count: orderedNodes.length,
    kind: 'batch',
    name: 'artifact-safety-unique-node',
    provider: 'artifact-namespace',
  });

  for (const [targetPath, roles] of orderedNodes) {
    options.metrics?.record({
      kind: 'batch',
      name: 'artifact-safety-lstat',
      provider: 'artifact-namespace',
    });
    const stats = await lstatIfPresent(targetPath);
    if (stats) assertArtifactPathStatsSafe(targetPath, stats, roles);
  }
}

/** Revalidates canonical containment immediately before a mutation. */
export async function assertArtifactPathOperationSafe(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  options: {
    metrics?: ArtifactSafetyMetricsRecorder;
    phase?: 'immediate';
    targetKind?: 'directory' | 'file';
  } = {},
): Promise<void> {
  const normalizedTarget = assertArtifactPathProjectedCanonicalContainment(
    namespace,
    targetPath,
  );
  if (options.phase === 'immediate') {
    options.metrics?.record({
      kind: options.targetKind,
      name: 'artifact-safety-immediate-recheck',
      provider: 'artifact-namespace',
    });
  }

  const relative = path.relative(namespace.rootDir, normalizedTarget);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let cursor = namespace.rootDir;
  for (const segment of ['', ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    const stats = await lstatIfPresent(cursor);
    if (!stats) continue;
    const roles = new Set<ArtifactPathSafetyRole>();
    if (cursor !== normalizedTarget) roles.add('parent-directory');
    if (cursor === normalizedTarget && options.targetKind === 'file') {
      roles.add('target-file');
    }
    if (cursor === normalizedTarget && options.targetKind === 'directory') {
      roles.add('target-directory');
    }
    assertArtifactPathStatsSafe(cursor, stats, roles);
  }
}

export async function ensureArtifactParentDirectory(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  options: { metrics?: ArtifactSafetyMetricsRecorder } = {},
): Promise<void> {
  await assertArtifactPathOperationSafe(namespace, targetPath, {
    metrics: options.metrics,
    phase: 'immediate',
    targetKind: 'file',
  });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertArtifactPathOperationSafe(namespace, targetPath, {
    metrics: options.metrics,
    phase: 'immediate',
    targetKind: 'file',
  });
}
