import type { PackageManifest } from '#core/workspace/actions';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function requiresNodeConditions(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, target]) =>
      key === 'module-sync' ||
      key === 'node-addons' ||
      requiresNodeConditions(target),
  );
}

function isScopeBoundary(directory: string): boolean {
  return (
    path.basename(directory) === 'node_modules' ||
    path.dirname(directory) === directory
  );
}

function findPackageScope(filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  while (!isScopeBoundary(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) return manifest;
    directory = path.dirname(directory);
  }
  return undefined;
}

export class ResourceNodeCompatibility {
  readonly #nodeConditions = new Map<string, boolean>();
  readonly #scopes = new Map<string, string | undefined>();
  readonly #readOwnerManifest:
    | ((manifestPath: string) => PackageManifest | undefined)
    | undefined;
  constructor(
    readOwnerManifest?: (manifestPath: string) => PackageManifest | undefined,
  ) {
    this.#readOwnerManifest = readOwnerManifest;
  }

  #hasNodeConditions(packageJsonPath: string | undefined): boolean {
    if (packageJsonPath === undefined) return false;
    const cached = this.#nodeConditions.get(packageJsonPath);
    if (cached !== undefined) return cached;
    const manifest = this.#readManifest(packageJsonPath);
    const found = [manifest.exports, manifest.imports].some(
      requiresNodeConditions,
    );
    this.#nodeConditions.set(packageJsonPath, found);
    return found;
  }

  #readManifest(packageJsonPath: string): PackageManifest {
    return (
      this.#readOwnerManifest?.(packageJsonPath) ??
      (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest)
    );
  }

  #getScope(filePath: string): string | undefined {
    const directory = path.dirname(filePath);
    if (!this.#scopes.has(directory))
      this.#scopes.set(directory, findPackageScope(filePath));
    return this.#scopes.get(directory);
  }

  #requiresExactImport(filePath: string, specifier: string): boolean {
    if (!specifier.startsWith('#')) return false;
    return (
      /[?#]/u.test(specifier.slice(1)) ||
      this.#hasNodeConditions(this.#getScope(filePath))
    );
  }

  requiresNode(options: {
    filePath: string;
    specifier: string;
    packageJsonPath?: string;
  }): boolean {
    return (
      this.#requiresExactImport(options.filePath, options.specifier) ||
      this.#hasNodeConditions(options.packageJsonPath)
    );
  }

  clear(): void {
    this.#scopes.clear();
    this.#nodeConditions.clear();
  }
}
