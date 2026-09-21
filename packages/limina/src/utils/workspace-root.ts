import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { parseDocument } from 'yaml';
import { normalizeAbsolutePath } from './path';

export type SupportedPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface WorkspaceRootDescriptor {
  kind: 'pnpm-workspace' | 'package-json-workspaces';
  path: string;
}

export interface ResolvedWorkspaceRoot {
  rootDir: string;
  descriptor: WorkspaceRootDescriptor;
  packageManager: SupportedPackageManager;
}

function isManifestObject(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  return typeof value === 'object' && !Array.isArray(value);
}

export function readWorkspaceRootManifest(
  filePath: string,
): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''),
  );
  if (!isManifestObject(value)) {
    throw new Error(`Invalid package.json object at ${filePath}.`);
  }
  return value as Record<string, unknown>;
}

export function hasWorkspaceDeclaration(manifest: object): boolean {
  return Object.hasOwn(manifest, 'workspaces');
}

/** Descriptor detection deliberately does not resolve the nested manager. */
export function findWorkspaceRootDescriptor(
  rootDir: string,
): WorkspaceRootDescriptor | null {
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) return { kind: 'pnpm-workspace', path: yamlPath };
  return findManifestDescriptor(rootDir);
}

function findManifestDescriptor(
  rootDir: string,
): WorkspaceRootDescriptor | null {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  return hasWorkspaceDeclaration(readWorkspaceRootManifest(manifestPath))
    ? { kind: 'package-json-workspaces', path: manifestPath }
    : null;
}

export function parsePackageManager(value: unknown): SupportedPackageManager {
  if (typeof value !== 'string')
    throw new Error(
      'Invalid packageManager declaration: expected manager@version.',
    );
  const match = /^([^@\s]+)@(\S+)$/u.exec(value);
  if (match === null)
    throw new Error(`Invalid packageManager declaration: ${value}.`);
  return supportedManager(match[1]!);
}

function supportedManager(manager: string): SupportedPackageManager {
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(manager))
    return manager as SupportedPackageManager;
  throw new Error(`Unsupported package manager: ${manager}.`);
}

const rootLockfiles: Record<SupportedPackageManager, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};

export function inferPackageManagerFromRootLockfiles(
  rootDir: string,
): SupportedPackageManager {
  const managers = (
    Object.keys(rootLockfiles) as SupportedPackageManager[]
  ).filter((manager) =>
    rootLockfiles[manager].some((file) => existsSync(path.join(rootDir, file))),
  );
  if (managers.length > 1)
    throw new Error(
      `Ambiguous package manager at ${rootDir}: ${managers.join(', ')}.`,
    );
  const manager = managers[0];
  if (manager === undefined)
    throw new Error(
      `Package manager undetermined at ${rootDir}. Declare packageManager or a same-root lockfile.`,
    );
  return manager;
}

function readExplicitManager(
  rootDir: string,
): SupportedPackageManager | undefined {
  const filePath = path.join(rootDir, 'package.json');
  if (!existsSync(filePath)) return undefined;
  const manifest = readWorkspaceRootManifest(filePath);
  return Object.hasOwn(manifest, 'packageManager')
    ? parsePackageManager(manifest.packageManager)
    : undefined;
}

function resolvePnpmManager(rootDir: string): SupportedPackageManager {
  const explicit = readExplicitManager(rootDir);
  if (explicit !== undefined && explicit !== 'pnpm') {
    throw new Error(
      `Conflicting package manager at ${rootDir}: pnpm-workspace.yaml with ${explicit}.`,
    );
  }
  return 'pnpm';
}

function resolveManifestManager(rootDir: string): SupportedPackageManager {
  const manager =
    readExplicitManager(rootDir) ??
    inferPackageManagerFromRootLockfiles(rootDir);
  if (manager === 'pnpm')
    throw new Error(
      `pnpm-workspace.yaml missing at ${rootDir}; pnpm requires its own workspace descriptor.`,
    );
  return manager;
}

export function resolveNearestWorkspaceRoot(
  startDir: string,
): ResolvedWorkspaceRoot {
  let rootDir = normalizeAbsolutePath(startDir);
  while (true) {
    const descriptor = findWorkspaceRootDescriptor(rootDir);
    if (descriptor !== null)
      return resolveWorkspaceDescriptor(rootDir, descriptor);
    rootDir = workspaceParentOrThrow(rootDir, startDir);
  }
}

function resolveWorkspaceDescriptor(
  rootDir: string,
  descriptor: WorkspaceRootDescriptor,
): ResolvedWorkspaceRoot {
  if (descriptor.kind === 'pnpm-workspace') {
    const errors = parseDocument(readFileSync(descriptor.path, 'utf8')).errors;
    if (errors.length > 0) throw errors[0];
    return { rootDir, descriptor, packageManager: resolvePnpmManager(rootDir) };
  }
  return {
    rootDir,
    descriptor,
    packageManager: resolveManifestManager(rootDir),
  };
}

function workspaceParentOrThrow(rootDir: string, startDir: string): string {
  const parent = path.dirname(rootDir);
  if (parent === rootDir)
    throw new Error(
      `No supported workspace descriptor found from ${startDir} or its ancestors.`,
    );
  return parent;
}
