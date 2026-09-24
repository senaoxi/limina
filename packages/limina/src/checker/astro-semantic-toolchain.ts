import type { PackageManifest } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { LiminaDependencyError } from '../dependency-contract';
import {
  formatAstroSemanticVersionTuple,
  resolveAstroSemanticAdapter,
} from './astro-semantic-compatibility';
import {
  createAstroLeafScopeIdentity,
  formatAstroToolchainError,
  readAstroSemanticVersionTuple,
  resolveAstroSemanticToolchainPaths,
} from './astro-semantic-discovery';
import { loadAstroSemanticRuntime } from './astro-semantic-runtime';
import type {
  AstroSemanticToolchain,
  AstroSemanticVersionTuple,
} from './astro-semantic-types';

export {
  isSupportedAstroSemanticVersionTuple,
  resolveAstroSemanticAdapter,
} from './astro-semantic-compatibility';

const ASTRO_SEMANTIC_SHAPE_IDENTITY = 'astro-7-check-0.9-shape-v1';

function createUnsupportedToolchainError(options: {
  ownerIdentity: string;
  packageRootDir: string;
  reason: string;
  versions?: AstroSemanticVersionTuple;
}): LiminaDependencyError {
  const version =
    options.versions === undefined
      ? ASTRO_SEMANTIC_SHAPE_IDENTITY
      : `${formatAstroSemanticVersionTuple(options.versions)}; ${ASTRO_SEMANTIC_SHAPE_IDENTITY}`;
  return new LiminaDependencyError({
    failureKind: 'unsupported',
    message: [
      'Unsupported Astro semantic toolchain:',
      `  leaf package scope: ${options.packageRootDir}`,
      `  reason: ${options.reason}`,
      '  fix: install a supported Astro 7 and @astrojs/check 0.9.10 toolchain in this leaf.',
    ].join('\n'),
    ownership: 'checker-toolchain',
    packageName: '@astrojs/check',
    scope: options.ownerIdentity,
    version,
  });
}

function assertSupportedTuple(options: {
  packageRootDir: string;
  versions: AstroSemanticVersionTuple;
  manifest?: PackageManifest;
}): void {
  const adapter = resolveAstroSemanticAdapter(options.versions);
  if (adapter.kind === 'supported') return;
  throw createUnsupportedToolchainError({
    ...options,
    ownerIdentity: createAstroLeafScopeIdentity(
      options.packageRootDir,
      options.manifest,
    ),
    reason: adapter.reason,
  });
}

export function resolveAstroSemanticToolchain(
  packageRootDir: string,
  manifest?: PackageManifest,
): AstroSemanticToolchain {
  let versions: AstroSemanticVersionTuple | undefined;
  try {
    const normalizedRoot = normalizeAbsolutePath(packageRootDir);
    const paths = resolveAstroSemanticToolchainPaths(normalizedRoot, manifest);
    versions = readAstroSemanticVersionTuple(paths);
    assertSupportedTuple({
      packageRootDir: normalizedRoot,
      versions,
      manifest,
    });
    return loadAstroSemanticRuntime({ paths, versions });
  } catch (error) {
    if (error instanceof LiminaDependencyError) throw error;
    throw createUnsupportedToolchainError({
      ownerIdentity: createAstroLeafScopeIdentity(packageRootDir, manifest),
      packageRootDir: normalizeAbsolutePath(packageRootDir),
      reason: formatAstroToolchainError(error),
      versions,
    });
  }
}
