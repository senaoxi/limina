import type { ResolvedCheckerConfig } from '#config/runner';
import { TypecheckLogger } from '../../logger';
import {
  formatTypecheckProblemSummaryReport,
  shouldLogCheckReport,
} from '../runner-shared';
import type {
  RunCheckerBuildOptions,
  RunCheckerBuildResult,
} from '../runner-types';
import { collectCheckerPeerDependencyProblems } from '../targets';

export function createCheckerBuildSelectionFailure(options: {
  problem: string;
  projectRootDir: string;
  report: RunCheckerBuildOptions['report'];
}): RunCheckerBuildResult {
  if (shouldLogCheckReport(options.report)) {
    TypecheckLogger.error(
      formatTypecheckProblemSummaryReport({
        pluralIssueLabel: 'checker build selection issues',
        problems: [options.problem],
        singularIssueLabel: 'checker build selection issue',
        title: 'Checker build summary',
      }),
    );
  }
  return {
    failedTargets: [],
    failureKind: 'target-selection',
    passed: false,
    problems: [options.problem],
    projectRootDir: options.projectRootDir,
    rootConfigPaths: [],
    targetResults: [],
  };
}

function failProgressItem(request: RunCheckerBuildOptions): boolean {
  const progress = request.progress;
  if (progress === undefined) return false;
  progress.startItem('checker dependency preflight').fail();
  return true;
}

function reportPeerDependencyProgress(options: {
  flowDepth: number;
  request: RunCheckerBuildOptions;
}): void {
  if (failProgressItem(options.request)) return;
  const flow = options.request.flow;
  if (flow === undefined) return;
  flow.fail('checker dependency preflight failed', {
    depth: options.flowDepth + 1,
  });
}

function reportPeerDependencyProblems(options: {
  issueLabel: 'checker build issue';
  problems: readonly string[];
  request: RunCheckerBuildOptions;
}): void {
  if (!shouldLogCheckReport(options.request.report)) return;
  TypecheckLogger.error(
    formatTypecheckProblemSummaryReport({
      pluralIssueLabel: `${options.issueLabel}s`,
      problems: options.problems,
      singularIssueLabel: options.issueLabel,
      title: 'Checker build summary',
    }),
  );
}

export function getCheckerBuildPeerProblems(options: {
  checkers: readonly ResolvedCheckerConfig[];
  projectRootDir: string;
  request: RunCheckerBuildOptions;
}): string[] {
  return collectCheckerPeerDependencyProblems({
    checkers: [...options.checkers],
    imports: options.request.config.config?.imports,
    projectRootDir: options.projectRootDir,
    resolvePackage: options.request.checkerPackageResolver,
  });
}

export function createCheckerBuildPeerFailure(options: {
  flowDepth: number;
  problems: readonly string[];
  projectRootDir: string;
  request: RunCheckerBuildOptions;
}): RunCheckerBuildResult | null {
  if (options.problems.length === 0) return null;
  reportPeerDependencyProgress(options);
  reportPeerDependencyProblems({
    issueLabel: 'checker build issue',
    problems: options.problems,
    request: options.request,
  });
  return {
    failedTargets: [],
    failureKind: 'peer-dependency',
    passed: false,
    problems: [...options.problems],
    projectRootDir: options.projectRootDir,
    rootConfigPaths: [],
    targetResults: [],
  };
}
