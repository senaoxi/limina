import type {
  CheckerDependencyRequirement,
  CheckerPackageResolver,
} from '#checkers';
import {
  getExternalCheckerDependencyContract,
  isSupportedDependencyVersion,
  type LiminaDependencyContract,
  readResolvedPackageVersion,
} from '../dependency-contract';
import type { TypecheckTarget } from './target-types';

export interface UnsupportedExternalChecker {
  packageName: string;
  supportedRange: string;
  version: string;
}

function getExternalCheckerContract(
  requirement: CheckerDependencyRequirement,
): LiminaDependencyContract | undefined {
  if (requirement.category !== 'external-checker') return undefined;
  return getExternalCheckerDependencyContract(requirement.packageName);
}

function resolveRequirementVersion(options: {
  packageName: string;
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
}): string | undefined {
  const resolvedPath = options.resolvePackage({
    packageName: options.packageName,
    projectRootDir: options.target.dependencyRootDir!,
  });
  if (resolvedPath === undefined) return undefined;
  return readResolvedPackageVersion({
    packageName: options.packageName,
    resolvedPath,
  });
}

function createUnsupportedExternalChecker(options: {
  contract: LiminaDependencyContract;
  version: string;
}): UnsupportedExternalChecker | undefined {
  if (
    isSupportedDependencyVersion({
      contract: options.contract,
      version: options.version,
    })
  ) {
    return undefined;
  }
  return {
    packageName: options.contract.packageName,
    supportedRange: options.contract.supportedRange,
    version: options.version,
  };
}

function evaluateRequirement(options: {
  requirement: CheckerDependencyRequirement;
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
}): UnsupportedExternalChecker | undefined {
  const contract = getExternalCheckerContract(options.requirement);
  if (contract === undefined) return undefined;
  const version = resolveRequirementVersion({
    packageName: contract.packageName,
    resolvePackage: options.resolvePackage,
    target: options.target,
  });
  if (version === undefined) return undefined;
  return createUnsupportedExternalChecker({ contract, version });
}

function isUnsupportedExternalChecker(
  value: UnsupportedExternalChecker | undefined,
): value is UnsupportedExternalChecker {
  return value !== undefined;
}

export function findUnsupportedExternalCheckers(options: {
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
}): UnsupportedExternalChecker[] {
  return (options.target.dependencyRequirements ?? [])
    .map((requirement) => evaluateRequirement({ ...options, requirement }))
    .filter(isUnsupportedExternalChecker);
}
