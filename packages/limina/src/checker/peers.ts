import type { ResolvedCheckerConfig } from '#config/runner';
import { createRequire } from 'node:module';
import path from 'pathe';
import { getCheckerAdapter } from './registry';
import type {
  CheckerPackageResolver,
  MissingCheckerPeerDependency,
} from './types';

function hasErrorCode(error: Error): error is Error & { code: unknown } {
  return 'code' in error;
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!hasErrorCode(error)) return undefined;
  return `${error.code}`;
}

function handleCheckerPackageResolutionError(
  error: unknown,
  packageName: string,
): string | undefined {
  const code = getErrorCode(error);
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return packageName;
  if (code === 'MODULE_NOT_FOUND') return undefined;
  throw error;
}

function resolveCheckerPackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromRoot = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );
  try {
    return requireFromRoot.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    return handleCheckerPackageResolutionError(error, options.packageName);
  }
}

function getPackageResolver(
  resolver: CheckerPackageResolver | undefined,
): CheckerPackageResolver {
  return resolver === undefined ? resolveCheckerPackageFromRoot : resolver;
}

function getPackageNames(checker: ResolvedCheckerConfig): string[] {
  const adapter = getCheckerAdapter(checker.preset);
  return adapter === null ? [] : adapter.packageNames;
}

function getOrCreateCheckerNames(
  missingByPackage: Map<string, Set<string>>,
  packageName: string,
): Set<string> {
  const checkerNames = missingByPackage.get(packageName);
  if (checkerNames !== undefined) return checkerNames;
  const created = new Set<string>();
  missingByPackage.set(packageName, created);
  return created;
}

function isPackageResolved(options: {
  checkerPackageResolver: CheckerPackageResolver;
  packageName: string;
  projectRootDir: string;
}): boolean {
  return (
    options.checkerPackageResolver({
      packageName: options.packageName,
      projectRootDir: options.projectRootDir,
    }) !== undefined
  );
}

function collectCheckerMissingPackages(options: {
  checker: ResolvedCheckerConfig;
  missingByPackage: Map<string, Set<string>>;
  projectRootDir: string;
  resolvePackage: CheckerPackageResolver;
}): void {
  for (const packageName of getPackageNames(options.checker)) {
    if (
      isPackageResolved({
        checkerPackageResolver: options.resolvePackage,
        packageName,
        projectRootDir: options.projectRootDir,
      })
    ) {
      continue;
    }
    getOrCreateCheckerNames(options.missingByPackage, packageName).add(
      options.checker.name,
    );
  }
}

function compareMissingDependencies(
  left: MissingCheckerPeerDependency,
  right: MissingCheckerPeerDependency,
): number {
  return left.packageName.localeCompare(right.packageName);
}

export function collectMissingCheckerPeerDependencies(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): MissingCheckerPeerDependency[] {
  const missingByPackage = new Map<string, Set<string>>();
  const resolvePackage = getPackageResolver(options.resolvePackage);
  for (const checker of options.checkers) {
    collectCheckerMissingPackages({
      checker,
      missingByPackage,
      projectRootDir: options.projectRootDir,
      resolvePackage,
    });
  }
  return [...missingByPackage.entries()]
    .map(([packageName, checkerNames]) => ({
      checkerNames: [...checkerNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      packageName,
    }))
    .sort(compareMissingDependencies);
}

function formatCheckerList(checkerNames: readonly string[]): string {
  return checkerNames.map((name) => `"${name}"`).join(', ');
}

function formatReason(reason: string | undefined): string {
  return reason === undefined ? '' : `; ${reason}`;
}

function formatMissingDependency(
  dependency: MissingCheckerPeerDependency,
): string {
  return `  - ${dependency.packageName} (used by checker ${formatCheckerList(
    dependency.checkerNames,
  )}${formatReason(dependency.reason)})`;
}

function collectPackageNames(
  dependencies: readonly MissingCheckerPeerDependency[],
): string[] {
  return dependencies.map((dependency) => dependency.packageName);
}

function collectMissingDependencyLines(
  dependencies: readonly MissingCheckerPeerDependency[],
): string[] {
  return dependencies.map(formatMissingDependency);
}

function joinMessageLines(lines: readonly string[]): string {
  return lines.join('\n');
}

export function formatMissingCheckerPeerDependencies(
  missingDependencies: MissingCheckerPeerDependency[],
): string {
  const packageNames = collectPackageNames(missingDependencies);
  const dependencyLines = collectMissingDependencyLines(missingDependencies);
  return joinMessageLines([
    'Missing checker peer dependencies:',
    ...dependencyLines,
    `Fix: pnpm add -D ${packageNames.join(' ')}`,
  ]);
}
