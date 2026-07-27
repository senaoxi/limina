import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  candidatePathsForBasePath,
  resolveExistingFilePath,
} from '#utils/module-resolution';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { collectPackageExportEntries } from './entries';

const declarationModulePattern = /\.d\.(?:cts|mts|ts)$/u;
const declarationExtensions = ['.d.ts', '.d.mts', '.d.cts'] as const;

function isResolvableDeclarationTarget(target: string): boolean {
  if (path.isAbsolute(target)) return false;
  return !target.includes('*');
}

function findDeclarationCandidate(basePath: string): string | undefined {
  return candidatePathsForBasePath(basePath, [...declarationExtensions])
    .map(resolveExistingFilePath)
    .find((candidate): candidate is string => candidate !== null);
}

function normalizeDeclarationCandidate(
  candidate: string | undefined,
): string | null {
  if (candidate === undefined) return null;
  if (!declarationModulePattern.test(candidate)) return null;
  return normalizeAbsolutePath(candidate);
}

function resolvePackageDeclarationTarget(
  packageDirectory: string,
  target: string,
): string | null {
  if (!isResolvableDeclarationTarget(target)) return null;
  const basePath = normalizeAbsolutePath(
    path.resolve(packageDirectory, target),
  );
  if (!isPathInsideDirectory(basePath, packageDirectory)) return null;
  return normalizeDeclarationCandidate(findDeclarationCandidate(basePath));
}

function resolveDeclarationTargets(
  packageDirectory: string,
  targets: readonly unknown[],
): string[] {
  return targets
    .filter((target): target is string => typeof target === 'string')
    .map((target) => resolvePackageDeclarationTarget(packageDirectory, target))
    .filter((target): target is string => target !== null);
}

function getManifestDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): unknown[] {
  return [workspacePackage.manifest.types, workspacePackage.manifest.typings];
}

async function collectExportDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): Promise<string[]> {
  if (workspacePackage.manifest.exports === undefined) return [];
  const collected = await collectPackageExportEntries(workspacePackage);
  return resolveDeclarationTargets(
    workspacePackage.directory,
    collected.entries.flatMap((entry) => entry.targets),
  );
}

async function collectPackageDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): Promise<string[]> {
  const direct = resolveDeclarationTargets(
    workspacePackage.directory,
    getManifestDeclarationTargets(workspacePackage),
  );
  const exported = await collectExportDeclarationTargets(workspacePackage);
  return [...direct, ...exported];
}

export async function collectWorkspacePackageDeclarationEntryPaths(
  packages: readonly WorkspacePackage[],
): Promise<Set<string>> {
  const namedPackages = packages.filter(isNamedWorkspacePackage);
  const paths = await Promise.all(
    namedPackages.map(collectPackageDeclarationTargets),
  );
  return new Set(paths.flat());
}
