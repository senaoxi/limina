import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type { Stats } from 'node:fs';
import { lstat as lstatAsync } from 'node:fs/promises';
import path from 'pathe';
import type { LiminaCheckIssue } from '../../../../source-check/snapshot';
import {
  canonicalProjectedPath,
  createWorkspaceIssue,
  displayWorkspacePath,
  isInsideOrEqual,
  isMissingFsError,
} from '../shared';

interface OutputIdentitySet {
  canonicalConfig: string;
  canonicalNamespace: string;
  canonicalOutput: string;
  canonicalPackages: string[];
  configRoot: string;
  namespaceRoot: string;
  outputRoot: string;
}

async function collectOutputIdentities(options: {
  activatedPackageRoots: readonly string[];
  configRoot: string;
  outputRoot: string;
}): Promise<OutputIdentitySet> {
  const configRoot = normalizeAbsolutePath(options.configRoot);
  const namespaceRoot = path.join(configRoot, '.limina');
  const outputRoot = normalizeAbsolutePath(options.outputRoot);
  return {
    canonicalConfig: await canonicalProjectedPath(configRoot),
    canonicalNamespace: await canonicalProjectedPath(namespaceRoot),
    canonicalOutput: await canonicalProjectedPath(outputRoot),
    canonicalPackages: await Promise.all(
      options.activatedPackageRoots.map(canonicalProjectedPath),
    ),
    configRoot,
    namespaceRoot,
    outputRoot,
  };
}

function isEqualsOrContains(parentPath: string, childPath: string): boolean {
  return parentPath === childPath || isInsideOrEqual(parentPath, childPath);
}

function isOverlapsConfigRoot(identities: OutputIdentitySet): boolean {
  const pairs = [
    [identities.outputRoot, identities.configRoot],
    [identities.canonicalOutput, identities.canonicalConfig],
  ] as const;
  return pairs.some(([parentPath, childPath]) =>
    isEqualsOrContains(parentPath, childPath),
  );
}

function isOverlapsPackageRoot(
  identities: OutputIdentitySet,
  packageRoots: readonly string[],
): boolean {
  const isLexicalOverlap = packageRoots.some((packageRoot) =>
    isInsideOrEqual(identities.outputRoot, packageRoot),
  );
  return (
    isLexicalOverlap ||
    identities.canonicalPackages.some((packageRoot) =>
      isInsideOrEqual(identities.canonicalOutput, packageRoot),
    )
  );
}

function isPathsOverlap(left: string, right: string): boolean {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

function isOverlapsNamespace(identities: OutputIdentitySet): boolean {
  const pairs = [
    [identities.outputRoot, identities.namespaceRoot],
    [identities.canonicalOutput, identities.canonicalNamespace],
  ] as const;
  return pairs.some(([left, right]) => isPathsOverlap(left, right));
}

async function tryReadOutputStats(outputRoot: string): Promise<Stats | null> {
  try {
    return await lstatAsync(outputRoot);
  } catch (error) {
    if (isMissingFsError(error)) return null;
    throw error;
  }
}

async function readExistingOutputProblem(
  outputRoot: string,
): Promise<string | null> {
  const stats = await tryReadOutputStats(outputRoot);
  return stats === null || stats.isDirectory()
    ? null
    : 'The existing output root is not a directory.';
}

function getConfigOverlapProblem(identities: OutputIdentitySet): string | null {
  return isOverlapsConfigRoot(identities)
    ? 'The output root equals or contains config.rootDir.'
    : null;
}

function getPackageOverlapProblem(options: {
  activatedPackageRoots: readonly string[];
  identities: OutputIdentitySet;
}): string | null {
  return isOverlapsPackageRoot(
    options.identities,
    options.activatedPackageRoots,
  )
    ? 'The output root equals or contains an activated package root.'
    : null;
}

function getNamespaceOverlapProblem(
  identities: OutputIdentitySet,
): string | null {
  return isOverlapsNamespace(identities)
    ? 'The output root overlaps the trusted .limina namespace.'
    : null;
}

function firstProblem(problems: readonly (string | null)[]): string | null {
  return problems.find((problem) => problem !== null) ?? null;
}

async function getOutputRootProblem(options: {
  activatedPackageRoots: readonly string[];
  configRoot: string;
  outputRoot: string;
}): Promise<string | null> {
  const identities = await collectOutputIdentities(options);
  return firstProblem([
    getConfigOverlapProblem(identities),
    getPackageOverlapProblem({
      activatedPackageRoots: options.activatedPackageRoots,
      identities,
    }),
    getNamespaceOverlapProblem(identities),
    await readExistingOutputProblem(identities.outputRoot),
  ]);
}

export async function validateOutputRoot(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  declaredAt: string;
  outputRoot: string;
}): Promise<LiminaCheckIssue | null> {
  const reason = await getOutputRootProblem({
    activatedPackageRoots: options.activatedPackageRoots,
    configRoot: options.config.rootDir,
    outputRoot: options.outputRoot,
  });
  if (reason === null) return null;
  const outputRoot = normalizeAbsolutePath(options.outputRoot);
  return createWorkspaceIssue({
    code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
    config: options.config,
    evidence: [
      `declaration: ${displayWorkspacePath(options.config.rootDir, options.declaredAt)}`,
      `output root: ${displayWorkspacePath(options.config.rootDir, outputRoot)}`,
    ],
    filePath: options.declaredAt,
    fix: 'Choose a dedicated output directory that does not own workspace or Limina roots.',
    reason,
    title: 'Workspace output root is structurally unsafe',
  });
}
