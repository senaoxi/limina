import { toRelativePath } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import { TypecheckLogger } from '../logger';
import type { LiminaPreflightManager } from '../preflight';
import { formatCheckIssueSummaryReport } from '../reporting';
import {
  formatManagedBuildCheckerSelectionProblem,
  formatMultipleOutputBuildPresetProblem,
} from './build/config-path';
import {
  formatOutputBuildTargetResolutionProblem,
  type ResolvedBuildTarget,
} from './build/target-resolution';
import type { CheckerBuildExecutionResult } from './checker/build-execution';
import {
  formatFailedTargetSummaryReport,
  formatTypecheckProblemSummaryReport,
  shouldLogCheckReport,
} from './runner-shared';
import type {
  RunBuildOptions,
  RunBuildResult,
  RunCheckerBuildOptions,
} from './runner-types';

export interface ManagedBuildContext {
  flowDepth: number;
  options: RunBuildOptions;
  preflight: LiminaPreflightManager;
  projectRootDir: string;
  target: Extract<ResolvedBuildTarget, { kind: 'managed' }>;
  workspaceContext: ValidatedWorkspaceContext;
}

function reportSelectionProblem(
  context: ManagedBuildContext,
  problem: string,
): void {
  if (!shouldLogCheckReport(context.options.report)) return;
  TypecheckLogger.error(
    formatCheckIssueSummaryReport({
      color: shouldUseColor(),
      details: problem,
      issueCount: 1,
      pluralIssueLabel: 'build selection issues',
      singularIssueLabel: 'build selection issue',
      title: 'Build summary',
    }),
  );
}

function createSelectionFailure(options: {
  context: ManagedBuildContext;
  problem: string;
}): RunBuildResult {
  reportSelectionProblem(options.context, options.problem);
  return {
    failedTargets: [],
    failureKind: 'target-selection',
    passed: false,
    problems: [options.problem],
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: [],
    sourceConfigPath: options.context.target.sourceConfigPath,
  };
}

function getEmptyTargetProblem(context: ManagedBuildContext): string | null {
  if (context.target.checkerTargets.length > 0) return null;
  const selectedChecker = context.target.selectedChecker;
  if (selectedChecker !== undefined) {
    return formatManagedBuildCheckerSelectionProblem({
      availableCheckers: context.target.availableCheckers,
      commandLabel: 'build',
      projectRootDir: context.projectRootDir,
      selectedChecker,
      sourceConfigPath: context.target.sourceConfigPath,
    });
  }
  return formatOutputBuildTargetResolutionProblem({
    matchingCheckers: context.target.matchingCheckers,
    projectRootDir: context.projectRootDir,
    resolutionKind: context.target.resolutionKind,
    sourceConfigPath: context.target.sourceConfigPath,
  });
}

function getAmbiguousTargetProblem(
  context: ManagedBuildContext,
): string | null {
  if (context.target.selectedChecker !== undefined) return null;
  if (context.target.checkerTargets.length <= 1) return null;
  return formatMultipleOutputBuildPresetProblem({
    availableCheckers: context.target.availableCheckers,
    projectRootDir: context.projectRootDir,
    sourceConfigPath: context.target.sourceConfigPath,
  });
}

export function validateManagedSelection(
  context: ManagedBuildContext,
): RunBuildResult | null {
  const problem =
    getEmptyTargetProblem(context) ?? getAmbiguousTargetProblem(context);
  if (problem === null) return null;
  return createSelectionFailure({ context, problem });
}

function reportPeerFailure(options: {
  context: ManagedBuildContext;
  problems: readonly string[];
}): void {
  options.context.options.flow?.fail('checker dependency preflight failed', {
    depth: options.context.flowDepth + 1,
  });
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.error(
    formatTypecheckProblemSummaryReport({
      pluralIssueLabel: 'checker build issues',
      problems: options.problems,
      singularIssueLabel: 'checker build issue',
      title: 'Checker build summary',
    }),
  );
}

export function createManagedPeerFailure(options: {
  context: ManagedBuildContext;
  problems: readonly string[];
}): RunBuildResult | null {
  if (options.problems.length === 0) return null;
  reportPeerFailure(options);
  return {
    failedTargets: [],
    passed: false,
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: [],
    sourceConfigPath: options.context.target.sourceConfigPath,
  };
}

export function logManagedBuildStart(options: {
  context: ManagedBuildContext;
  cwd: string;
  rootConfigPaths: readonly string[];
  targetCount: number;
}): void {
  options.context.options.flow?.info(
    `found ${options.targetCount} build target(s)`,
    { depth: options.context.flowDepth + 1 },
  );
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.info(
    [
      `Running build for ${options.targetCount} generated target(s).`,
      ...getManagedDependencyDescription(options.context.target),
      `Source: ${toRelativePath(
        options.context.projectRootDir,
        options.context.target.sourceConfigPath,
      )}`,
      `CWD: ${toRelativePath(options.cwd, options.context.projectRootDir)}`,
      `Entries: ${options.rootConfigPaths
        .map((configPath) =>
          toRelativePath(options.context.projectRootDir, configPath),
        )
        .join(', ')}`,
    ].join('\n'),
  );
}

function getManagedDependencyDescription(
  target: ManagedBuildContext['target'],
): string[] {
  return target.resolutionKind === 'managed-dependency'
    ? [
        'Target: TypeScript dependency solution (framework application build is not included).',
      ]
    : [];
}

export function toCheckerBuildOptions(
  options: RunBuildOptions,
): RunCheckerBuildOptions {
  return {
    checker: options.checker,
    checkerPackageResolver: options.checkerPackageResolver,
    clearScreen: options.clearScreen,
    config: options.config,
    configPath: options.configPath,
    cwd: options.cwd,
    flow: options.flow,
    flowDepth: options.flowDepth,
    generatedGraphProvider: options.generatedGraphProvider,
    preflight: options.preflight,
    providers: options.providers,
    report: options.report,
    runner: options.runner,
    tscCommand: options.tscCommand,
    watch: options.watch,
  };
}

export function reportManagedFailure(options: {
  context: ManagedBuildContext;
  execution: CheckerBuildExecutionResult;
}): void {
  if (options.execution.failedResults.length === 0) return;
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.error(
    formatFailedTargetSummaryReport({
      failedResults: options.execution.failedResults,
      heading: 'build failed:',
      pluralIssueLabel: 'failed checker build targets',
      projectRootDir: options.context.projectRootDir,
      singularIssueLabel: 'failed checker build target',
      title: 'Checker build summary',
    }),
  );
}

function shouldReportManagedSuccess(context: ManagedBuildContext): boolean {
  if (!shouldLogCheckReport(context.options.report)) return false;
  return context.options.flow?.interactive !== true;
}

export function reportManagedSuccess(options: {
  context: ManagedBuildContext;
  targetCount: number;
}): void {
  if (!shouldReportManagedSuccess(options.context)) return;
  TypecheckLogger.success(`Built ${options.targetCount} generated target(s).`);
}

export function createManagedExecutionFailure(options: {
  context: ManagedBuildContext;
  execution: CheckerBuildExecutionResult;
  rootConfigPaths: string[];
}): RunBuildResult {
  return {
    failedTargets: options.execution.failedTargets,
    passed: false,
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: options.rootConfigPaths,
    sourceConfigPath: options.context.target.sourceConfigPath,
  };
}

export function createCopyFailure(options: {
  context: ManagedBuildContext;
  execution: CheckerBuildExecutionResult;
  problem: string;
  rootConfigPaths: string[];
}): RunBuildResult {
  return {
    failedTargets: options.execution.failedTargets,
    failureKind: 'process',
    passed: false,
    problems: [options.problem],
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: options.rootConfigPaths,
    sourceConfigPath: options.context.target.sourceConfigPath,
  };
}

export function createManagedSuccess(options: {
  context: ManagedBuildContext;
  execution: CheckerBuildExecutionResult;
  rootConfigPaths: string[];
}): RunBuildResult {
  return {
    failedTargets: options.execution.failedTargets,
    passed: true,
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: options.rootConfigPaths,
    sourceConfigPath: options.context.target.sourceConfigPath,
  };
}

export type { BuildTargetDescriptor } from './build/target-resolution';
