import {
  type CheckerPackageResolver,
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
  getCheckerAdapter,
} from '#checkers';
import type {
  CheckerExecutionKind,
  ResolvedCheckerConfig,
} from '#config/runner';

export function getExecutionCheckers(options: {
  checkers: ResolvedCheckerConfig[];
  executionKind: CheckerExecutionKind;
}): ResolvedCheckerConfig[] {
  return options.checkers.filter((checker) => {
    const adapter = getCheckerAdapter(checker.name);
    return adapter?.execution === options.executionKind;
  });
}

export function collectCheckerPeerDependencyDetails(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): ReturnType<typeof collectMissingCheckerPeerDependencies> {
  return collectMissingCheckerPeerDependencies({
    checkers: options.checkers,
    projectRootDir: options.projectRootDir,
    resolvePackage: options.resolvePackage,
  });
}

export function collectCheckerPeerDependencyProblems(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): string[] {
  const missingDependencies = collectCheckerPeerDependencyDetails(options);
  return missingDependencies.length === 0
    ? []
    : [formatMissingCheckerPeerDependencies(missingDependencies)];
}
