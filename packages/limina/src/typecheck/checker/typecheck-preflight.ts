import {
  type CheckerPackageResolver,
  formatMissingCheckerPeerDependencies,
} from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type {
  RunCheckerTypecheckOptions,
  RunCheckerTypecheckResult,
} from '../runner-types';
import {
  collectCheckerPeerDependencyDetails,
  collectFrameworkTargetPreflightFailures,
  type FrameworkTargetPreflightFailure,
  type TypecheckTarget,
} from '../targets';
import { createTypecheckPeerFailure } from './typecheck-reporting';

type MissingCheckerPeers = ReturnType<
  typeof collectCheckerPeerDependencyDetails
>;

function formatConfiguredPeerProblems(
  peerDependencies: MissingCheckerPeers,
): string[] {
  if (peerDependencies.length === 0) return [];
  return [formatMissingCheckerPeerDependencies(peerDependencies)];
}

function collectCheckerNames(
  peerDependencies: MissingCheckerPeers,
  frameworkFailures: readonly FrameworkTargetPreflightFailure[],
): string[] {
  return [
    ...new Set([
      ...peerDependencies.flatMap((dependency) => dependency.checkerNames),
      ...frameworkFailures.map((failure) => failure.checkerName),
    ]),
  ].sort();
}

export function collectTypecheckPeerFailure(options: {
  checkerPackageResolver?: CheckerPackageResolver;
  checkers: ResolvedCheckerConfig[];
  flowDepth: number;
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
  targets: readonly TypecheckTarget[];
}): RunCheckerTypecheckResult | undefined {
  const peerDependencies = collectCheckerPeerDependencyDetails({
    checkers: options.checkers,
    projectRootDir: options.projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });
  const frameworkFailures = collectFrameworkTargetPreflightFailures({
    resolvePackage: options.checkerPackageResolver,
    targets: options.targets,
    workspaceRootDir: options.projectRootDir,
  });
  const problems = [
    ...formatConfiguredPeerProblems(peerDependencies),
    ...frameworkFailures.flatMap((failure) => failure.problems),
  ];
  if (problems.length === 0) return undefined;
  return createTypecheckPeerFailure({
    checkerNames: collectCheckerNames(peerDependencies, frameworkFailures),
    flowDepth: options.flowDepth,
    problems,
    projectRootDir: options.projectRootDir,
    request: options.request,
  });
}
