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

/** Revalidates canonical containment immediately before a mutation. */
export async function assertArtifactPathOperationSafe(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  options: { targetKind?: 'directory' | 'file' } = {},
): Promise<void> {
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

  const relative = path.relative(namespace.rootDir, normalizedTarget);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let cursor = namespace.rootDir;
  for (const segment of ['', ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    const stats = await lstatIfPresent(cursor);
    if (!stats) continue;
    if (stats.isSymbolicLink()) {
      throw new ArtifactNamespaceContainmentError(
        `Generated-artifact mutation crosses a symbolic link: ${cursor}.`,
      );
    }
    if (cursor !== normalizedTarget && !stats.isDirectory()) {
      throw new ArtifactNamespaceContainmentError(
        `Generated-artifact parent is not a directory: ${cursor}.`,
      );
    }
    if (
      cursor === normalizedTarget &&
      options.targetKind === 'file' &&
      !stats.isFile()
    ) {
      throw new ArtifactNamespaceContainmentError(
        `Generated-artifact target is not a regular file: ${cursor}.`,
      );
    }
    if (
      cursor === normalizedTarget &&
      options.targetKind === 'directory' &&
      !stats.isDirectory()
    ) {
      throw new ArtifactNamespaceContainmentError(
        `Generated-artifact target is not a directory: ${cursor}.`,
      );
    }
  }
}

export async function ensureArtifactParentDirectory(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): Promise<void> {
  await assertArtifactPathOperationSafe(namespace, targetPath, {
    targetKind: 'file',
  });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertArtifactPathOperationSafe(namespace, targetPath, {
    targetKind: 'file',
  });
}
