import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { LiminaDependencyError } from '../dependency-contract';
import type {
  AstroSemanticToolchainPaths,
  AstroSemanticVersionTuple,
} from './astro-semantic-types';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
}

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export function formatAstroToolchainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readManifest(manifestPath: string): PackageManifest {
  const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isPlainRecord(value)) {
    throw new TypeError(`Package manifest ${manifestPath} is not an object.`);
  }
  return value as PackageManifest;
}

function readVersion(manifestPath: string): string {
  const version = readManifest(manifestPath).version;
  if (typeof version === 'string') return version;
  throw new TypeError(
    `Package manifest ${manifestPath} does not expose a string version.`,
  );
}

function createManifestScopeIdentity(manifestPath: string): string {
  const manifest = readManifest(manifestPath);
  return JSON.stringify({
    name: manifest.name ?? '<anonymous>',
    version: manifest.version,
  });
}

export function createAstroLeafScopeIdentity(packageRootDir: string): string {
  try {
    return createManifestScopeIdentity(
      path.join(packageRootDir, 'package.json'),
    );
  } catch {
    return JSON.stringify({
      kind: 'leaf',
      name: path.basename(packageRootDir),
    });
  }
}

function declaresDependency(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return dependencyFields.some((field) =>
    Object.hasOwn(manifest[field] ?? {}, packageName),
  );
}

function isMatchingManifest(
  manifestPath: string,
  packageName: string,
): boolean {
  try {
    return readManifest(manifestPath).name === packageName;
  } catch {
    return false;
  }
}

function findManifestForResolvedEntry(options: {
  packageName: string;
  resolvedEntryPath: string;
}): string | null {
  let previousDirectory = '';
  let directory = path.dirname(options.resolvedEntryPath);
  while (directory !== previousDirectory) {
    const manifestPath = path.join(directory, 'package.json');
    if (isMatchingManifest(manifestPath, options.packageName)) {
      return normalizeAbsolutePath(manifestPath);
    }
    previousDirectory = directory;
    directory = path.dirname(directory);
  }
  return null;
}

function resolvePackageManifestWithOwnerRequire(options: {
  ownerRequire: NodeRequire;
  packageName: string;
}): string {
  try {
    return normalizeAbsolutePath(
      options.ownerRequire.resolve(`${options.packageName}/package.json`),
    );
  } catch {
    const resolvedEntryPath = options.ownerRequire.resolve(options.packageName);
    const manifestPath = findManifestForResolvedEntry({
      packageName: options.packageName,
      resolvedEntryPath,
    });
    if (manifestPath !== null) return manifestPath;
    throw new TypeError(
      `Resolved ${options.packageName} entry ${resolvedEntryPath} has no matching package manifest ancestor.`,
    );
  }
}

function createMissingPackageError(options: {
  ownerManifestPath: string;
  ownerScope: string;
  packageName: string;
  reason: string;
}): LiminaDependencyError {
  return new LiminaDependencyError({
    failureKind: 'missing',
    message: [
      'Missing Astro semantic toolchain dependency:',
      `  package: ${options.packageName}`,
      `  owner scope: ${options.ownerScope}`,
      `  owner manifest: ${options.ownerManifestPath}`,
      `  reason: ${options.reason}`,
      '  fix: install the supported Astro/check toolchain in the owning leaf package.',
    ].join('\n'),
    ownership:
      options.packageName === 'astro' ||
      options.packageName === '@astrojs/check'
        ? 'external-checker'
        : 'checker-toolchain',
    packageName: options.packageName,
    scope: createManifestScopeIdentity(options.ownerManifestPath),
  });
}

function resolveOwnedPackageManifest(options: {
  ownerManifestPath: string;
  ownerScope: string;
  packageName: string;
}): string {
  const ownerManifest = readManifest(options.ownerManifestPath);
  if (!declaresDependency(ownerManifest, options.packageName)) {
    throw createMissingPackageError({
      ...options,
      reason: `${options.packageName} is not declared by the owner scope; workspace-root fallback is not permitted.`,
    });
  }
  try {
    return resolvePackageManifestWithOwnerRequire({
      ownerRequire: createRequire(options.ownerManifestPath),
      packageName: options.packageName,
    });
  } catch (error) {
    throw createMissingPackageError({
      ...options,
      reason: formatAstroToolchainError(error),
    });
  }
}

function resolveLeafManifest(packageRootDir: string): string {
  const manifestPath = normalizeAbsolutePath(
    path.join(packageRootDir, 'package.json'),
  );
  readManifest(manifestPath);
  return manifestPath;
}

export function resolveAstroSemanticToolchainPaths(
  packageRootDir: string,
): AstroSemanticToolchainPaths {
  const leafManifest = resolveLeafManifest(packageRootDir);
  const astro = resolveOwnedPackageManifest({
    ownerManifestPath: leafManifest,
    ownerScope: packageRootDir,
    packageName: 'astro',
  });
  const check = resolveOwnedPackageManifest({
    ownerManifestPath: leafManifest,
    ownerScope: packageRootDir,
    packageName: '@astrojs/check',
  });
  const leafTypeScript = resolveOwnedPackageManifest({
    ownerManifestPath: leafManifest,
    ownerScope: packageRootDir,
    packageName: 'typescript',
  });
  const checkRoot = path.dirname(check);
  const languageServer = resolveOwnedPackageManifest({
    ownerManifestPath: check,
    ownerScope: checkRoot,
    packageName: '@astrojs/language-server',
  });
  const typeScript = resolveOwnedPackageManifest({
    ownerManifestPath: check,
    ownerScope: checkRoot,
    packageName: 'typescript',
  });
  const languageServerRoot = path.dirname(languageServer);
  const compiler = resolveOwnedPackageManifest({
    ownerManifestPath: languageServer,
    ownerScope: languageServerRoot,
    packageName: '@astrojs/compiler',
  });
  const languageCore = resolveOwnedPackageManifest({
    ownerManifestPath: languageServer,
    ownerScope: languageServerRoot,
    packageName: '@volar/language-core',
  });
  const volarKit = resolveOwnedPackageManifest({
    ownerManifestPath: languageServer,
    ownerScope: languageServerRoot,
    packageName: '@volar/kit',
  });
  const vscodeUri = resolveOwnedPackageManifest({
    ownerManifestPath: languageServer,
    ownerScope: languageServerRoot,
    packageName: 'vscode-uri',
  });
  const volarTypeScript = resolveOwnedPackageManifest({
    ownerManifestPath: volarKit,
    ownerScope: path.dirname(volarKit),
    packageName: '@volar/typescript',
  });
  return {
    astro,
    check,
    compiler,
    languageCore,
    languageServer,
    leafTypeScript,
    typeScript,
    volarKit,
    volarTypeScript,
    vscodeUri,
  };
}

export function readAstroSemanticVersionTuple(
  paths: AstroSemanticToolchainPaths,
): AstroSemanticVersionTuple {
  return {
    astro: readVersion(paths.astro),
    check: readVersion(paths.check),
    compiler: readVersion(paths.compiler),
    languageCore: readVersion(paths.languageCore),
    languageServer: readVersion(paths.languageServer),
    leafTypeScript: readVersion(paths.leafTypeScript),
    typeScript: readVersion(paths.typeScript),
    volarKit: readVersion(paths.volarKit),
    volarTypeScript: readVersion(paths.volarTypeScript),
  };
}
