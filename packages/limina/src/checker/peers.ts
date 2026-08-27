import type { ResolvedCheckerConfig } from '#config/runner';
import { createRequire } from 'node:module';
import path from 'pathe';
import {
  getExternalCheckerDependencyContract,
  getLiminaRuntimeDependencyContract,
  isSupportedDependencyVersion,
  type LiminaDependencyContract,
  readResolvedPackageVersion,
} from '../dependency-contract';
import { getCheckerAdapter } from './registry';
import type {
  CheckerPackageResolver,
  MissingCheckerPeerDependency,
} from './types';

interface AccumulatedDependencyProblem
  extends Omit<MissingCheckerPeerDependency, 'checkerNames'> {
  checkerNames: Set<string>;
}

const requireFromLimina = createRequire(import.meta.url);

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

function resolvePackageEntryFallback(options: {
  packageName: string;
  requireFromRoot: NodeRequire;
}): string | undefined {
  try {
    return options.requireFromRoot.resolve(options.packageName);
  } catch (error) {
    if (getErrorCode(error) === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

function resolvePackageWithRequire(options: {
  packageName: string;
  requireFrom: NodeRequire;
}): string | undefined {
  try {
    return options.requireFrom.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    return handlePackageResolutionError({ error, ...options });
  }
}

function handlePackageResolutionError(options: {
  error: unknown;
  packageName: string;
  requireFrom: NodeRequire;
}): string | undefined {
  if (getErrorCode(options.error) === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return resolvePackageEntryFallback({
      packageName: options.packageName,
      requireFromRoot: options.requireFrom,
    });
  }
  if (getErrorCode(options.error) === 'MODULE_NOT_FOUND') return undefined;
  throw options.error;
}

function resolveCheckerPackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  return resolvePackageWithRequire({
    packageName: options.packageName,
    requireFrom: createRequire(
      path.join(options.projectRootDir, 'package.json'),
    ),
  });
}

function resolveDependency(options: {
  contract: LiminaDependencyContract;
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): string | undefined {
  if (options.resolvePackage !== undefined) {
    return options.resolvePackage({
      packageName: options.contract.packageName,
      projectRootDir: options.projectRootDir,
    });
  }
  if (options.contract.ownership === 'limina-runtime') {
    return resolvePackageWithRequire({
      packageName: options.contract.packageName,
      requireFrom: requireFromLimina,
    });
  }
  return resolveCheckerPackageFromRoot({
    packageName: options.contract.packageName,
    projectRootDir: options.projectRootDir,
  });
}

function getResolutionScope(options: {
  contract: LiminaDependencyContract;
  projectRootDir: string;
}): string {
  return options.contract.ownership === 'limina-runtime'
    ? 'limina-install'
    : options.projectRootDir;
}

function getPackageNames(checker: ResolvedCheckerConfig): string[] {
  const adapter = getCheckerAdapter(checker.name);
  return adapter === null
    ? []
    : [
        ...adapter.dependencies.externalCheckerPackages,
        ...adapter.dependencies.liminaRuntimePackages,
      ];
}

function requireDependencyContract(
  packageName: string,
): LiminaDependencyContract {
  const contract =
    getExternalCheckerDependencyContract(packageName) ??
    getLiminaRuntimeDependencyContract(packageName);
  if (contract !== undefined) return contract;
  throw new Error(
    `Checker dependency ${packageName} has no ownership contract.`,
  );
}

function createDependencyProblem(options: {
  checkerName: string;
  contract: LiminaDependencyContract;
  resolutionScope: string;
  resolvedPath: string | undefined;
}): AccumulatedDependencyProblem | undefined {
  if (options.resolvedPath === undefined) {
    return createMissingDependencyProblem(options);
  }
  return createInstalledDependencyProblem({
    checkerName: options.checkerName,
    contract: options.contract,
    resolutionScope: options.resolutionScope,
    resolvedPath: options.resolvedPath,
  });
}

function createMissingDependencyProblem(options: {
  checkerName: string;
  contract: LiminaDependencyContract;
  resolutionScope: string;
}): AccumulatedDependencyProblem {
  return {
    checkerNames: new Set([options.checkerName]),
    failureKind: 'missing',
    ownership: options.contract.ownership,
    packageName: options.contract.packageName,
    resolutionScope: options.resolutionScope,
    supportedRange: options.contract.supportedRange,
  };
}

function createInstalledDependencyProblem(options: {
  checkerName: string;
  contract: LiminaDependencyContract;
  resolutionScope: string;
  resolvedPath: string;
}): AccumulatedDependencyProblem | undefined {
  const installedVersion = readResolvedPackageVersion({
    packageName: options.contract.packageName,
    resolvedPath: options.resolvedPath,
  });
  if (installedVersion === undefined) return undefined;
  if (
    isSupportedDependencyVersion({
      contract: options.contract,
      version: installedVersion,
    })
  ) {
    return undefined;
  }
  return {
    checkerNames: new Set([options.checkerName]),
    failureKind: 'unsupported',
    installedVersion,
    ownership: options.contract.ownership,
    packageName: options.contract.packageName,
    reason: `installed version ${installedVersion} is outside ${options.contract.supportedRange}`,
    resolutionScope: options.resolutionScope,
    supportedRange: options.contract.supportedRange,
  };
}

function dependencyProblemKey(problem: AccumulatedDependencyProblem): string {
  return JSON.stringify({
    failureKind: problem.failureKind,
    ownership: problem.ownership,
    packageName: problem.packageName,
    resolutionScope: problem.resolutionScope,
    version: problem.installedVersion,
  });
}

function registerDependencyProblem(
  problemsByKey: Map<string, AccumulatedDependencyProblem>,
  problem: AccumulatedDependencyProblem,
): void {
  const key = dependencyProblemKey(problem);
  const current = problemsByKey.get(key);
  if (current === undefined) {
    problemsByKey.set(key, problem);
    return;
  }
  for (const checkerName of problem.checkerNames) {
    current.checkerNames.add(checkerName);
  }
}

function collectCheckerDependencyProblems(options: {
  checker: ResolvedCheckerConfig;
  problemsByKey: Map<string, AccumulatedDependencyProblem>;
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): void {
  for (const packageName of getPackageNames(options.checker)) {
    const contract = requireDependencyContract(packageName);
    const problem = createDependencyProblem({
      checkerName: options.checker.name,
      contract,
      resolutionScope: getResolutionScope({
        contract,
        projectRootDir: options.projectRootDir,
      }),
      resolvedPath: resolveDependency({
        contract,
        projectRootDir: options.projectRootDir,
        resolvePackage: options.resolvePackage,
      }),
    });
    if (problem !== undefined) {
      registerDependencyProblem(options.problemsByKey, problem);
    }
  }
}

function compareDependencyProblems(
  left: MissingCheckerPeerDependency,
  right: MissingCheckerPeerDependency,
): number {
  return (
    left.ownership.localeCompare(right.ownership) ||
    left.failureKind.localeCompare(right.failureKind) ||
    left.packageName.localeCompare(right.packageName)
  );
}

export function collectMissingCheckerPeerDependencies(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): MissingCheckerPeerDependency[] {
  const problemsByKey = new Map<string, AccumulatedDependencyProblem>();
  for (const checker of options.checkers) {
    collectCheckerDependencyProblems({
      checker,
      problemsByKey,
      projectRootDir: options.projectRootDir,
      resolvePackage: options.resolvePackage,
    });
  }
  return [...problemsByKey.values()]
    .map((problem) => ({
      ...problem,
      checkerNames: [...problem.checkerNames].sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort(compareDependencyProblems);
}

export { formatMissingCheckerPeerDependencies } from './dependency-diagnostics';
