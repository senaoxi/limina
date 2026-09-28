import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
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

export function normalizeArtifactAbsolutePath(value: string): string {
  return path.normalize(path.resolve(value));
}

export function isArtifactPathInsideOrEqual(
  parentPath: string,
  childPath: string,
): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

type SegmentSafetyCheck = (segment: string) => boolean;

const unsafeSegmentChecks: readonly SegmentSafetyCheck[] = [
  (segment) => segment.length === 0,
  (segment) => segment === '.',
  (segment) => segment === '..',
  (segment) => path.isAbsolute(segment),
  (segment) => segment.includes('/'),
  (segment) => segment.includes('\\'),
];

function rejectUnsafeSegment(segment: string): void {
  const unsafe = unsafeSegmentChecks.some((check) => check(segment));

  if (unsafe) {
    throw new ArtifactNamespaceContainmentError(
      `Unsafe generated-artifact path segment: ${JSON.stringify(segment)}.`,
    );
  }
}

export function createLiminaArtifactNamespace(options: {
  generation: number;
  rootDir: string;
}): LiminaArtifactNamespace {
  const configRootDir = normalizeArtifactAbsolutePath(options.rootDir);
  const canonicalConfigRootDir = normalizeArtifactAbsolutePath(
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
  const normalizedTarget = normalizeArtifactAbsolutePath(targetPath);

  if (!isArtifactPathInsideOrEqual(namespace.rootDir, normalizedTarget)) {
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

  for (const segment of segments) {
    rejectUnsafeSegment(segment);
  }

  const targetPath = normalizeArtifactAbsolutePath(
    path.join(namespace.rootDir, ...segments),
  );
  assertArtifactPathLexicallyContained(namespace, targetPath);
  return targetPath;
}

type RelativePathSafetyCheck = (options: {
  normalized: string;
  relativePath: string;
}) => boolean;

const unsafeRelativePathChecks: readonly RelativePathSafetyCheck[] = [
  ({ relativePath }) => relativePath.length === 0,
  ({ relativePath }) => path.isAbsolute(relativePath),
  ({ normalized }) => normalized === '..',
  ({ normalized }) => normalized.startsWith(`..${path.sep}`),
];

function assertSafeRelativePath(
  relativePath: string,
  normalized: string,
): void {
  const unsafe = unsafeRelativePathChecks.some((check) =>
    check({ normalized, relativePath }),
  );

  if (unsafe) {
    throw new ArtifactNamespaceContainmentError(
      `Unsafe generated-artifact relative path: ${JSON.stringify(relativePath)}.`,
    );
  }
}

export function resolveArtifactNamespaceRelativePath(
  namespace: LiminaArtifactNamespace,
  relativePath: string,
): string {
  const normalized = path.normalize(relativePath);
  assertSafeRelativePath(relativePath, normalized);
  const targetPath = normalizeArtifactAbsolutePath(
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
    normalizeArtifactAbsolutePath(targetPath),
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
