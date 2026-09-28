import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { parseDocument } from 'yaml';
import type { PackageManifest } from '../core/workspace/package-types';
import {
  type GovernanceRootBase,
  hasManifestEntry,
  isManifestObject,
  readWorkspaceRootManifest,
  resolveGovernanceManifest,
} from './governance-manifest';
export {
  findNearestPackageManifest,
  hasManifestEntry,
  readGovernanceManifest,
  readWorkspaceRootManifest,
  resolveGovernanceManifest,
  type GovernanceRootBase,
} from './governance-manifest';

export type SupportedPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface WorkspaceRootDescriptor {
  kind: 'pnpm-workspace' | 'package-json-workspaces';
  path: string;
}

export type ResolvedGovernanceRoot =
  | (GovernanceRootBase & {
      readonly kind: 'workspace';
      readonly descriptor: WorkspaceRootDescriptor;
      readonly packageManager: SupportedPackageManager;
    })
  | (GovernanceRootBase & { readonly kind: 'single-package' });

export type ResolvedWorkspaceRoot = Extract<
  ResolvedGovernanceRoot,
  { kind: 'workspace' }
>;

export function resolveGovernanceRoot(
  configPath: string,
): ResolvedGovernanceRoot {
  return classifyGovernanceRoot(
    resolveGovernanceManifest(path.dirname(configPath)),
  );
}

export function classifyGovernanceRoot(
  root: GovernanceRootBase,
): ResolvedGovernanceRoot {
  const descriptor = findWorkspaceRootDescriptor(root.rootDir, root.manifest);
  if (descriptor === null)
    return Object.freeze({ ...root, kind: 'single-package' });
  return Object.freeze(resolveWorkspaceDescriptor(root, descriptor));
}

export function hasWorkspaceDeclaration(manifest: object): boolean {
  return Object.hasOwn(manifest, 'workspaces');
}

/** Descriptor detection deliberately does not resolve the nested manager. */
export function findWorkspaceRootDescriptor(
  rootDir: string,
  manifest?: Readonly<PackageManifest>,
): WorkspaceRootDescriptor | null {
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (hasManifestEntry(yamlPath))
    return { kind: 'pnpm-workspace', path: yamlPath };
  return findManifestDescriptor(rootDir, manifest);
}

function findManifestDescriptor(
  rootDir: string,
  manifest?: Readonly<PackageManifest>,
): WorkspaceRootDescriptor | null {
  const manifestPath = path.join(rootDir, 'package.json');
  const contents = manifest ?? readLocalManifest(manifestPath);
  return isWorkspaceManifest(contents)
    ? { kind: 'package-json-workspaces', path: manifestPath }
    : null;
}

function isWorkspaceManifest(manifest: PackageManifest | null): boolean {
  return manifest !== null && hasWorkspaceDeclaration(manifest);
}
function readLocalManifest(manifestPath: string): PackageManifest | null {
  return hasManifestEntry(manifestPath)
    ? readWorkspaceRootManifest(manifestPath)
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
  manifest: Readonly<PackageManifest>,
): SupportedPackageManager | undefined {
  return Object.hasOwn(manifest, 'packageManager')
    ? parsePackageManager(manifest.packageManager)
    : undefined;
}

function resolvePnpmManager({
  rootDir,
  manifest,
}: GovernanceRootBase): SupportedPackageManager {
  const explicit = readExplicitManager(manifest);
  if (explicit !== undefined && explicit !== 'pnpm') {
    throw new Error(
      `Conflicting package manager at ${rootDir}: pnpm-workspace.yaml with ${explicit}.`,
    );
  }
  return 'pnpm';
}

function resolveManifestManager({
  rootDir,
  manifest,
}: GovernanceRootBase): SupportedPackageManager {
  const manager =
    readExplicitManager(manifest) ??
    inferPackageManagerFromRootLockfiles(rootDir);
  if (manager === 'pnpm')
    throw new Error(
      `pnpm-workspace.yaml missing at ${rootDir}; pnpm requires its own workspace descriptor.`,
    );
  return manager;
}

/** Capability-only resolution. Single-package governance does not call this. */
export function resolveGovernancePackageManager(
  root: ResolvedGovernanceRoot,
): SupportedPackageManager {
  if (root.kind === 'workspace') return root.packageManager;
  return (
    readExplicitManager(root.manifest) ??
    inferPackageManagerFromRootLockfiles(root.rootDir)
  );
}

function resolveWorkspaceDescriptor(
  root: GovernanceRootBase,
  descriptor: WorkspaceRootDescriptor,
): ResolvedWorkspaceRoot {
  const packageManager =
    descriptor.kind === 'pnpm-workspace'
      ? inspectPnpmWorkspace(root, descriptor)
      : inspectManifestWorkspace(root);
  return { ...root, kind: 'workspace', descriptor, packageManager };
}

function inspectPnpmWorkspace(
  root: GovernanceRootBase,
  descriptor: WorkspaceRootDescriptor,
): SupportedPackageManager {
  const document = parseDocument(readFileSync(descriptor.path, 'utf8'));
  if (document.errors.length > 0) throw document.errors[0];
  validatePnpmPackages(document.toJSON());
  return resolvePnpmManager(root);
}

function validatePnpmPackages(value: unknown): void {
  if (!isManifestObject(value)) return;
  if (Object.hasOwn(value, 'packages'))
    validateWorkspaceGlobs(value.packages, 'pnpm');
}

function getManifestWorkspaceGlobs(
  declaration: unknown,
  manager: SupportedPackageManager,
): unknown {
  if (manager === 'npm' || Array.isArray(declaration)) return declaration;
  return getWorkspaceObjectPackages(declaration);
}

function getWorkspaceObjectPackages(declaration: unknown): unknown {
  return isManifestObject(declaration) ? declaration.packages : undefined;
}

function inspectManifestWorkspace(
  root: GovernanceRootBase,
): SupportedPackageManager {
  const manager = resolveManifestManager(root);
  validateWorkspaceGlobs(
    getManifestWorkspaceGlobs(root.manifest.workspaces, manager),
    manager,
  );
  return manager;
}

function validateWorkspaceGlobs(
  value: unknown,
  manager: SupportedPackageManager,
): void {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  )
    throw new Error(
      `Invalid ${manager} workspace declaration: expected a string array.`,
    );
}
