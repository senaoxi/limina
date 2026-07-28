import { TypecheckLogger } from '../../logger';
import {
  formatFailedTargetSummaryReport,
  formatTypecheckProblemSummaryReport,
  shouldLogCheckReport,
} from '../runner-shared';
import type {
  RunCheckerTypecheckOptions,
  RunCheckerTypecheckResult,
} from '../runner-types';
import type { TypecheckTargetResult } from '../targets';

function reportNoCheckerProgress(options: {
  flowDepth: number;
  request: RunCheckerTypecheckOptions;
}): void {
  const progress = options.request.progress;
  if (progress !== undefined) {
    progress.startItem('second-class checker entries').pass();
    return;
  }
  options.request.flow?.info('no second-class checker entries configured', {
    depth: options.flowDepth + 1,
  });
}

function shouldLogSuccess(request: RunCheckerTypecheckOptions): boolean {
  if (!shouldLogCheckReport(request.report)) return false;
  return request.flow?.interactive !== true;
}

export function createNoTypecheckCheckerResult(options: {
  flowDepth: number;
  projectRootDir: string;
  request: RunCheckerTypecheckOptions;
}): RunCheckerTypecheckResult {
  reportNoCheckerProgress(options);
  if (shouldLogSuccess(options.request)) {
    TypecheckLogger.success('No second-class checker entries configured.');
  }
  return {
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
    failedTargets: [],
    failureKind: 'peer-dependency',
    passed: false,
    problems: [...options.problems],
    projectRootDir: options.projectRootDir,
    rootConfigPaths: [],
    targetResults: [],
  };
}

function reportTypecheckFailure(options: {
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
  if (reportTypecheckFailure(options)) return;
  if (!shouldLogSuccess(options.request)) return;
  TypecheckLogger.success(
    `Checked ${options.targetCount} checker typecheck entry(s).`,
  );
}
