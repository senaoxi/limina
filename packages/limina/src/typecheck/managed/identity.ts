import { getCheckerAdapter } from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import type { TypecheckTarget } from '../targets';
import type { ConfigDependencyIdentity } from './types';
import { ManagedCheckerEmitBoundaryError } from './types';

function canonicalizeRecord(value: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function canonicalizeNonArray(value: unknown): unknown {
  if (value === null) return value;
  if (typeof value !== 'object') return value;
  return canonicalizeRecord(value as Record<string, unknown>);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  return canonicalizeNonArray(value);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

let compilerIdentity: string | undefined;

function calculateCompilerIdentity(): string {
  const require = createRequire(import.meta.url);
  const implementationPath = realpathSync.native(require.resolve('typescript'));
  const stats = statSync(implementationPath);
  return hashValue({
    dev: String(stats.dev),
    hash: createHash('sha256')
      .update(readFileSync(implementationPath))
      .digest('hex'),
    ino: String(stats.ino),
    path: implementationPath,
    version: ts.version,
  });
}

function getCompilerIdentity(): string {
  if (compilerIdentity === undefined) {
    compilerIdentity = calculateCompilerIdentity();
  }
  return compilerIdentity;
}

function createIdentityBase(
  logicalPath: string,
  stats: Stats,
): Pick<ConfigDependencyIdentity, 'canonicalPath' | 'dev' | 'ino' | 'path'> {
  return {
    canonicalPath: normalizeAbsolutePath(realpathSync.native(logicalPath)),
    dev: String(stats.dev),
    ino: String(stats.ino),
    path: logicalPath,
  };
}

function getSymlinkTargetKind(
  targetStats: Stats,
  logicalPath: string,
): 'directory' | 'file' {
  if (targetStats.isDirectory()) return 'directory';
  if (targetStats.isFile()) return 'file';
  throw new ManagedCheckerEmitBoundaryError(
    `Checker config dependency link has an unsupported target: ${logicalPath}.`,
  );
}

function addSymlinkFileIdentity(options: {
  identity: ConfigDependencyIdentity;
  logicalPath: string;
  targetStats: Stats;
}): ConfigDependencyIdentity {
  if (!options.targetStats.isFile()) return options.identity;
  const content = readFileSync(options.logicalPath);
  return {
    ...options.identity,
    targetHash: createHash('sha256').update(content).digest('hex'),
    targetLength: content.byteLength,
    targetMode: Number(options.targetStats.mode) & 0o7777,
    targetNlink: Number(options.targetStats.nlink),
  };
}

function createSymlinkIdentity(options: {
  base: ReturnType<typeof createIdentityBase>;
  logicalPath: string;
}): ConfigDependencyIdentity {
  const targetStats = statSync(options.logicalPath) as Stats;
  const identity: ConfigDependencyIdentity = {
    ...options.base,
    kind: 'symlink',
    linkTarget: readlinkSync(options.logicalPath),
    targetDev: String(targetStats.dev),
    targetIno: String(targetStats.ino),
    targetKind: getSymlinkTargetKind(targetStats, options.logicalPath),
  };
  return addSymlinkFileIdentity({
    identity,
    logicalPath: options.logicalPath,
    targetStats,
  });
}

function createFileIdentity(options: {
  base: ReturnType<typeof createIdentityBase>;
  logicalPath: string;
  stats: Stats;
}): ConfigDependencyIdentity {
  const content = readFileSync(options.logicalPath);
  return {
    ...options.base,
    hash: createHash('sha256').update(content).digest('hex'),
    kind: 'file',
    length: content.byteLength,
    mode: Number(options.stats.mode) & 0o7777,
    nlink: Number(options.stats.nlink),
  };
}

function captureNonSymlinkIdentity(options: {
  base: ReturnType<typeof createIdentityBase>;
  logicalPath: string;
  stats: Stats;
}): ConfigDependencyIdentity {
  if (options.stats.isDirectory()) {
    return { ...options.base, kind: 'directory' };
  }
  if (options.stats.isFile()) return createFileIdentity(options);
  throw new ManagedCheckerEmitBoundaryError(
    `Checker config dependency is not a regular file: ${options.logicalPath}.`,
  );
}

export function captureConfigDependencyIdentity(
  dependencyPath: string,
): ConfigDependencyIdentity {
  const logicalPath = normalizeAbsolutePath(dependencyPath);
  const stats = lstatSync(logicalPath) as Stats;
  const base = createIdentityBase(logicalPath, stats);
  if (stats.isSymbolicLink()) {
    return createSymlinkIdentity({ base, logicalPath });
  }
  return captureNonSymlinkIdentity({ base, logicalPath, stats });
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!('code' in error)) return undefined;
  return String(error.code);
}

function isPackageResolutionMiss(error: unknown): boolean {
  const code = getErrorCode(error);
  return new Set(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND']).has(
    code ?? '',
  );
}

function resolveCheckerPackageManifest(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromProject = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );
  try {
    return normalizeAbsolutePath(
      requireFromProject.resolve(`${options.packageName}/package.json`),
    );
  } catch (error) {
    if (isPackageResolutionMiss(error)) return undefined;
    throw error;
  }
}

function getPackageIdentity(options: {
  packageName: string;
  projectRootDir: string;
}): unknown {
  const manifestPath = resolveCheckerPackageManifest(options);
  if (manifestPath === undefined) {
    return {
      packageName: options.packageName,
      resolution: 'externally-resolved',
    };
  }
  return {
    identity: captureConfigDependencyIdentity(manifestPath),
    packageName: options.packageName,
  };
}

function getCommandPath(options: {
  projectRootDir: string;
  target: TypecheckTarget;
}): string {
  if (path.isAbsolute(options.target.command)) {
    return normalizeAbsolutePath(options.target.command);
  }
  return normalizeAbsolutePath(
    path.join(
      options.projectRootDir,
      'node_modules',
      '.bin',
      options.target.command,
    ),
  );
}

function isMissingPathError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT';
}

function getCommandIdentity(options: {
  projectRootDir: string;
  target: TypecheckTarget;
}): unknown {
  try {
    return captureConfigDependencyIdentity(getCommandPath(options));
  } catch (error) {
    if (isMissingPathError(error)) {
      return { command: options.target.command, resolution: 'path-search' };
    }
    throw error;
  }
}

export function getCheckerImplementationFingerprint(options: {
  checker: ResolvedCheckerConfig;
  projectRootDir: string;
  target: TypecheckTarget;
}): string {
  const adapter = getCheckerAdapter(options.checker.preset);
  if (adapter === null) {
    throw new ManagedCheckerEmitBoundaryError(
      `Unable to identify checker implementation for ${options.checker.preset}.`,
    );
  }
  return hashValue({
    commandIdentity: getCommandIdentity(options),
    packageIdentities: adapter.packageNames.map((packageName) =>
      getPackageIdentity({
        packageName,
        projectRootDir: options.projectRootDir,
      }),
    ),
    preset: options.checker.preset,
    projectionCompiler: getCompilerIdentity(),
    projectionCompilerVersion: ts.version,
  });
}
