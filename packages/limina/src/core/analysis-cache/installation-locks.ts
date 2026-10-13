import { isPlainRecord } from '#utils/values';
import { execFileSync } from 'node:child_process';
import path from 'pathe';
import ts from 'typescript';
import { parse, parseAllDocuments } from 'yaml';
interface LockRoots {
  lockRoot: string;
  resolutionRoot: string;
}
function importerPath(roots: LockRoots): string {
  return path.relative(roots.lockRoot, roots.resolutionRoot) || '.';
}
function requireImporter(
  importers: Record<string, unknown> | undefined,
  key: string,
  roots: LockRoots,
): void {
  if (!Object.hasOwn(importers ?? {}, key))
    throw new Error(
      `Lock does not cover resolution root: ${roots.resolutionRoot}`,
    );
}
interface PnpmLock {
  lockfileVersion: number;
  importers: Record<string, Record<string, unknown>>;
}
function pnpmLockVersion(value: unknown): number {
  if (
    !['string', 'number'].includes(typeof value) ||
    ![6, 9].includes(Number(value))
  )
    throw new Error('Unproven pnpm lock version.');
  return Number(value);
}
function pnpmImporters(value: unknown): PnpmLock['importers'] {
  if (!isPlainRecord(value) || !Object.values(value).every(isPlainRecord))
    throw new Error('Unproven pnpm lock importers.');
  return value as PnpmLock['importers'];
}
function pnpmDocument(value: unknown): PnpmLock {
  if (!isPlainRecord(value)) throw new Error('Unproven pnpm lock document.');
  return {
    lockfileVersion: pnpmLockVersion(value.lockfileVersion),
    importers: pnpmImporters(value.importers),
  };
}
function pnpmDocuments(text: string): PnpmLock[] {
  const documents = parseAllDocuments(text);
  if (![1, 2].includes(documents.length))
    throw new Error('Unproven pnpm lock document layout.');
  return documents.map((document) => {
    if (document.errors.length > 0) throw document.errors[0];
    return pnpmDocument(document.toJS());
  });
}
function hasEnvironmentDependencies(importer: Record<string, unknown>) {
  return ['configDependencies', 'packageManagerDependencies'].some((key) =>
    Object.hasOwn(importer, key),
  );
}
function isEnvironmentLock(lock: PnpmLock): boolean {
  const importers = Object.values(lock.importers);
  return (
    importers.length > 0 &&
    importers.every(
      (importer) =>
        hasEnvironmentDependencies(importer) &&
        ['dependencies', 'devDependencies', 'optionalDependencies'].every(
          (key) => !Object.hasOwn(importer, key),
        ),
    )
  );
}
function validateEnvironmentLock(environment: PnpmLock, project: PnpmLock) {
  if (
    !isEnvironmentLock(environment) ||
    environment.lockfileVersion !== project.lockfileVersion
  )
    throw new Error('Unproven pnpm lock document layout.');
}
function validatePnpm(text: string, roots: LockRoots): void {
  const documents = pnpmDocuments(text);
  // pnpm writes an optional environment document before the project lock.
  // Only the project importers prove coverage; the caller observes all bytes.
  const project = documents.at(-1)!;
  if (Object.values(project.importers).some(hasEnvironmentDependencies))
    throw new Error('Unproven pnpm lock document layout.');
  if (documents.length === 2) validateEnvironmentLock(documents[0]!, project);
  requireImporter(project.importers, importerPath(roots), roots);
}
function validateNpm(text: string, roots: LockRoots): void {
  const value = JSON.parse(text) as {
    lockfileVersion?: number;
    packages?: Record<string, unknown>;
  };
  requireVersion(value.lockfileVersion, [1, 2, 3]);
  return value.lockfileVersion === 1
    ? validateLegacyRoot(roots)
    : requireImporter(
        value.packages,
        path.relative(roots.lockRoot, roots.resolutionRoot),
        roots,
      );
}
function validateLegacyRoot(roots: LockRoots): void {
  if (roots.lockRoot !== roots.resolutionRoot)
    throw new Error('Unproven legacy workspace lock coverage.');
}
function validateYarn(text: string, roots: LockRoots): void {
  if (text.includes('# yarn lockfile v1')) return;
  validateModernYarn(text, roots);
}
function validateModernYarn(text: string, roots: LockRoots): void {
  const value = parse(text) as Record<
    string,
    { version?: number; resolution?: string }
  >;
  requireVersion(value.__metadata?.version, [8]);
  const suffix = `@workspace:${importerPath(roots)}`;
  if (
    Object.values(value).every((entry) => !entry?.resolution?.endsWith(suffix))
  )
    throw new Error('Yarn lock does not cover this workspace.');
}
function requireVersion(
  value: number | undefined,
  allowed: readonly number[],
): void {
  if (!allowed.includes(value!))
    throw new Error('Unproven installation lock version.');
}
function validateBunText(text: string, roots: LockRoots): void {
  const parsed = ts.parseConfigFileTextToJson('bun.lock', text);
  if (parsed.error !== undefined) throw new Error('Invalid Bun text lock.');
  const value = parsed.config as {
    lockfileVersion?: number;
    workspaces?: Record<string, unknown>;
  };
  requireVersion(value.lockfileVersion, [1, 2]);
  requireImporter(
    value.workspaces,
    path.relative(roots.lockRoot, roots.resolutionRoot),
    roots,
  );
}
function validateBun(options: {
  file: string;
  bytes: Buffer;
  roots: LockRoots;
}): void {
  if (!options.file.endsWith('.lockb')) {
    validateBunText(options.bytes.toString('utf8'), options.roots);
    return;
  }
  validateLegacyRoot(options.roots);
  if (
    !options.bytes
      .subarray(0, 42)
      .equals(Buffer.from('#!/usr/bin/env bun\nbun-lockfile-format-v0\n'))
  )
    throw new Error('Unproven Bun binary lock version.');
  // The installed decoder validates the binary representation. No lossy text
  // conversion participates in its input version or invalidation.
  execFileSync('bun', [options.file], {
    cwd: options.roots.lockRoot,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function validateInstallationLock(options: {
  manager: string;
  file: string;
  bytes: Buffer;
  roots: LockRoots;
}): void {
  return options.manager === 'bun'
    ? validateBun(options)
    : validateTextLock(options);
}
function validateTextLock(
  options: Parameters<typeof validateInstallationLock>[0],
): void {
  const validators: Record<string, (text: string, roots: LockRoots) => void> = {
    pnpm: validatePnpm,
    npm: validateNpm,
    yarn: validateYarn,
  };
  validators[options.manager]!(options.bytes.toString('utf8'), options.roots);
}
