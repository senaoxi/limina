import { execFileSync } from 'node:child_process';
import path from 'pathe';
import ts from 'typescript';
import { parse } from 'yaml';
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
function validatePnpm(text: string, roots: LockRoots): void {
  const value = parse(text) as {
    lockfileVersion?: string | number;
    importers?: Record<string, unknown>;
  };
  if (![6, 9].includes(Number(value.lockfileVersion)))
    throw new Error('Unproven pnpm lock version.');
  requireImporter(value.importers, importerPath(roots), roots);
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
