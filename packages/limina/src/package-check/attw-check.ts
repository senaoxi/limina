import type {
  PackageAttwCheckConfig,
  PackageAttwProfile,
} from '#config/runner';
import type { CheckPackageOptions, Problem } from '@arethetypeswrong/core';
import { createElapsedTimer } from 'logaria/helper';
import {
  formatMissingOptionalToolSkipMessage,
  isLiminaOptionalToolMissingError,
} from '../execution/tools';
import { PackageLogger } from '../logger';
import {
  ATTW_PROFILE_IGNORED_RESOLUTIONS,
  getAttwProblemRuleName,
} from './attw-format';
import {
  type AttwCheckOptions,
  type AttwTask,
  finishAttwProblems,
  finishNoTypes,
  finishPassedAttw,
  reportAttwProblem,
} from './attw-reporting';
import { loadAttwPeer } from './peer-tools';
import type { PackageToolCheckResult } from './runner-types';

type AttwPeer = Awaited<ReturnType<typeof loadAttwPeer>>;

function createTask(options: AttwCheckOptions): AttwTask | undefined {
  if (options.flow === undefined) return undefined;
  return options.flow.start(`attw: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
}

function requireOptionalToolError(error: unknown) {
  if (!isLiminaOptionalToolMissingError(error)) throw error;
  return error;
}

function skipMissingPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  error: unknown;
  label: string;
  task: AttwTask | undefined;
}): null {
  const optionalError = requireOptionalToolError(options.error);
  const message = formatMissingOptionalToolSkipMessage(optionalError.toolName);
  PackageLogger.warn(`${message}: ${options.label}`, options.elapsed());
  if (options.task !== undefined) options.task.skip(message);
  return null;
}

async function resolveAttwPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: AttwTask | undefined;
}): Promise<AttwPeer | null> {
  try {
    return await loadAttwPeer();
  } catch (error) {
    return skipMissingPeer({ ...options, error });
  }
}

function createCheckOptions(
  config: PackageAttwCheckConfig,
): CheckPackageOptions {
  return {
    entrypoints: config.entrypoints,
    entrypointsLegacy: config.entrypointsLegacy,
    excludeEntrypoints: config.excludeEntrypoints,
    includeEntrypoints: config.includeEntrypoints,
  };
}

function isIgnoredResolution(
  problem: Problem,
  ignoredResolutions: readonly string[],
): boolean {
  if (!('resolutionKind' in problem)) return false;
  return ignoredResolutions.includes(problem.resolutionKind);
}

function shouldKeepProblem(options: {
  ignoredResolutions: readonly string[];
  ignoredRuleNames: ReadonlySet<string>;
  problem: Problem;
}): boolean {
  if (isIgnoredResolution(options.problem, options.ignoredResolutions)) {
    return false;
  }
  return !options.ignoredRuleNames.has(getAttwProblemRuleName(options.problem));
}

function collectRelevantProblems(options: {
  config: PackageAttwCheckConfig;
  problems: readonly Problem[];
  profile: PackageAttwProfile;
}): Problem[] {
  const ignoredResolutions = ATTW_PROFILE_IGNORED_RESOLUTIONS[options.profile];
  const ignoredRuleNames = new Set(options.config.ignoreRules);
  return options.problems.filter((problem) =>
    shouldKeepProblem({ ignoredResolutions, ignoredRuleNames, problem }),
  );
}

function reportProblems(
  problems: readonly Problem[],
  options: AttwCheckOptions,
): void {
  for (const problem of problems) reportAttwProblem(problem, options);
}

function finishProblemResult(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  problems: readonly Problem[];
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  reportProblems(options.problems, options.checkOptions);
  return finishAttwProblems({
    checkOptions: options.checkOptions,
    count: options.problems.length,
    elapsed: options.elapsed,
    task: options.task,
  });
}

async function executeTypedAttw(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  peer: AttwPeer;
  task: AttwTask | undefined;
}): Promise<PackageToolCheckResult> {
  const pkg = options.peer.createPackageFromTarballData(
    options.checkOptions.tarball,
  );
  const result = await options.peer.checkPackage(
    pkg,
    createCheckOptions(options.checkOptions.config),
  );
  if (!result.types) return finishNoTypes(options);
  const problems = collectRelevantProblems({
    config: options.checkOptions.config,
    problems: result.problems,
    profile: options.checkOptions.profile,
  });
  if (problems.length === 0) return finishPassedAttw(options);
  return finishProblemResult({ ...options, problems });
}

export async function runAttwCheck(
  options: AttwCheckOptions,
): Promise<PackageToolCheckResult> {
  const task = createTask(options);
  const elapsed = createElapsedTimer();
  const peer = await resolveAttwPeer({
    elapsed,
    label: options.label,
    task,
  });
  if (peer === null) return 'skipped';
  PackageLogger.info(
    `attw started: ${options.label} (profile: ${options.profile})`,
  );
  return executeTypedAttw({ checkOptions: options, elapsed, peer, task });
}
