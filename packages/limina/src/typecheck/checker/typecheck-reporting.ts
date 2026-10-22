import { TypecheckLogger } from '../../logger';
import {
  admissionFailureTargets,
  executionFailureKind,
} from '../admission/reporting';
import {
  collectFailedCheckerTargets,
  formatFailedTargetSummaryReport,
  formatTypecheckProblemSummaryReport,
  shouldLogCheckReport,
} from '../runner-shared';
import type {
  RunCheckerTypecheckOptions,
  RunCheckerTypecheckResult,
} from '../runner-types';
import type { TypecheckTargetResult } from '../targets';
import {
  type BuildTargetCompletion,
  toCheckerTargetOutcome,
  type TypecheckTarget,
} from '../targets';

function reportNoCheckerProgress(options: {
  flowDepth: number;
  request: RunCheckerTypecheckOptions;
}): void {
  options.request.flow?.info(
    'checker typecheck is disabled (no framework targets)',
    {
      depth: options.flowDepth + 1,
    },
  );
}

function shouldLogSuccess(request: RunCheckerTypecheckOptions): boolean {
  return (
    shouldLogCheckReport(request.report) && request.flow?.interactive !== true
  );
}

export function createNoTypecheckCheckerResult(options: {
  flowDepth: number;
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
}): RunCheckerTypecheckResult {
  reportNoCheckerProgress(options);
  if (shouldLogSuccess(options.request)) {
    TypecheckLogger.info(
      'checker typecheck is disabled: no Svelte or Astro targets were discovered.',
    );
  }
  return {
    disabled: true,
    failedTargets: [],
    passed: true,
    projectRootDir: options.projectRootDir,
    rootConfigPaths: [],
    targetResults: [],
  };
}

function failPeerProgress(options: {
  flowDepth: number;
  request: RunCheckerTypecheckOptions;
}): void {
  const progress = options.request.progress;
  if (progress !== undefined) {
    progress.startItem('checker dependency preflight').fail();
    return;
  }
  options.request.flow?.fail('checker dependency preflight failed', {
    depth: options.flowDepth + 1,
  });
}

export function createTypecheckPeerFailure(options: {
  checkerNames: readonly string[];
  flowDepth: number;
  problems: readonly string[];
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
}): RunCheckerTypecheckResult {
  failPeerProgress(options);
  if (shouldLogCheckReport(options.request.report)) {
    TypecheckLogger.error(
      formatTypecheckProblemSummaryReport({
        pluralIssueLabel: 'checker typecheck issues',
        problems: options.problems,
        singularIssueLabel: 'checker typecheck issue',
        title: 'Checker typecheck summary',
      }),
    );
  }
  return {
    checkerNames: [...options.checkerNames],
    disabled: false,
    failedTargets: [],
    failureKind: 'peer-dependency',
    passed: false,
    problems: [...options.problems],
    projectRootDir: options.projectRootDir,
    rootConfigPaths: [],
    targetResults: [],
  };
}

function isReportTypecheckFailure(options: {
  failedResults: readonly TypecheckTargetResult[];
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
}): boolean {
  if (options.failedResults.length === 0) return false;
  if (shouldLogCheckReport(options.request.report)) {
    TypecheckLogger.error(
      formatFailedTargetSummaryReport({
        failedResults: options.failedResults,
        heading: 'typecheck checks failed:',
        pluralIssueLabel: 'failed checker typecheck targets',
        projectRootDir: options.projectRootDir,
        singularIssueLabel: 'failed checker typecheck target',
        title: 'Checker typecheck summary',
      }),
    );
  }
  return true;
}

export function reportTypecheckResult(options: {
  failedResults: readonly TypecheckTargetResult[];
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
  targetCount: number;
}): void {
  if (isReportTypecheckFailure(options) || !shouldLogSuccess(options.request))
    return;
  TypecheckLogger.success(
    `Checked ${options.targetCount} checker typecheck entry(s).`,
  );
}

export function createTypecheckExecutionResult(options: {
  completions: BuildTargetCompletion[];
  targets: TypecheckTarget[];
  request: RunCheckerTypecheckOptions;
  projectRootDir: string;
  rootConfigPaths: string[];
}): RunCheckerTypecheckResult {
  const results = options.completions.filter(
    (item): item is TypecheckTargetResult => typeof item.status === 'number',
  );
  const refused = options.completions.filter(
    (item) => typeof item.status !== 'number',
  );
  const failedResults = results.filter((item) => item.status !== 0);
  if (refused.length === 0)
    reportTypecheckResult({
      ...options,
      failedResults,
      targetCount: options.targets.length,
    });
  return {
    disabled: false,
    failedTargets: [
      ...collectFailedCheckerTargets(options.targets, failedResults),
      ...admissionFailureTargets(options.targets, refused),
    ],
    failureKind: executionFailureKind(failedResults, refused),
    targetResults: results,
    targetOutcomes: options.completions.map((result) =>
      typeof result.status === 'number'
        ? toCheckerTargetOutcome(
            options.targets.find((target) => target.id === result.id)!,
            result,
          )
        : result,
    ),
    passed: [failedResults.length, refused.length].every(
      (length) => length === 0,
    ),
    projectRootDir: options.projectRootDir,
    rootConfigPaths: options.rootConfigPaths,
  };
}
