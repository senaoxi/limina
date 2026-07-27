import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { LiminaFlowTask } from '../flow';
import { TypecheckLogger } from '../logger';
import { runBuildTargets } from './build/plan';
import {
  createRawBuildChecker,
  type ResolvedBuildTarget,
} from './build/target-resolution';
import {
  collectFailedCheckerTargets,
  completeCheckerTargetTask,
  formatFailedTargetSummaryReport,
  formatTypecheckProblemSummaryReport,
  resolveTypecheckRunner,
  shouldLogCheckReport,
} from './runner-shared';
import type { RunBuildOptions, RunBuildResult } from './runner-types';
import {
  type CheckerTargetId,
  collectCheckerPeerDependencyProblems,
  createCheckerTarget,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './targets';

interface RawBuildContext {
  cwd: string;
  flowDepth: number;
  options: RunBuildOptions;
  projectRootDir: string;
  target: Extract<ResolvedBuildTarget, { kind: 'raw' }>;
}

function reportPeerDependencyFlow(context: RawBuildContext): void {
  context.options.flow?.fail('checker dependency preflight failed', {
    depth: context.flowDepth + 1,
  });
}

function reportPeerDependencyDetails(options: {
  context: RawBuildContext;
  problems: readonly string[];
}): void {
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.error(
    formatTypecheckProblemSummaryReport({
      pluralIssueLabel: 'build issues',
      problems: options.problems,
      singularIssueLabel: 'build issue',
      title: 'Build summary',
    }),
  );
}

function createPeerDependencyFailure(options: {
  context: RawBuildContext;
  problems: readonly string[];
}): RunBuildResult | null {
  if (options.problems.length === 0) return null;
  reportPeerDependencyFlow(options.context);
  reportPeerDependencyDetails(options);
  return {
    failedTargets: [],
    failureKind: 'peer-dependency',
    passed: false,
    problems: [...options.problems],
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: [],
    sourceConfigPath: null,
  };
}

function createRawTarget(context: RawBuildContext): {
  checker: ReturnType<typeof createRawBuildChecker>;
  target: TypecheckTarget;
} {
  const checker = createRawBuildChecker({
    preset: context.target.checker,
    projectRootDir: context.projectRootDir,
  });
  return {
    checker,
    target: {
      ...createCheckerTarget({
        checker,
        commandOverride: context.options.tscCommand,
        configPath: context.target.targetConfigPath,
        executionKind: 'build',
        projectRootDir: context.projectRootDir,
        sourceConfigPath: context.target.targetConfigPath,
        watch: context.options.watch,
      }),
      sourceConfigPath: context.target.targetConfigPath,
    },
  };
}

function logRawBuildStart(context: RawBuildContext): void {
  if (!shouldLogCheckReport(context.options.report)) return;
  TypecheckLogger.info(
    [
      'Running raw build target.',
      `Checker: ${context.target.checker}`,
      `Config: ${toRelativePath(
        context.projectRootDir,
        context.target.targetConfigPath,
      )}`,
      `CWD: ${toRelativePath(context.cwd, context.projectRootDir)}`,
    ].join('\n'),
  );
}

function startRawTargetTask(options: {
  context: RawBuildContext;
  target: TypecheckTarget;
  tasks: Map<CheckerTargetId, LiminaFlowTask>;
}): void {
  const flow = options.context.options.flow;
  if (flow === undefined) return;
  const label =
    options.target.label ??
    `build: ${toRelativePath(
      options.context.projectRootDir,
      options.target.configPath,
    )}`;
  options.tasks.set(
    options.target.id,
    flow.start(label, {
      collapseOnSuccess: false,
      depth: options.context.flowDepth + 1,
    }),
  );
}

function completeRawTargetTask(options: {
  result: TypecheckTargetResult;
  target: TypecheckTarget;
  tasks: ReadonlyMap<CheckerTargetId, LiminaFlowTask>;
}): void {
  const task = options.tasks.get(options.target.id);
  if (task !== undefined) completeCheckerTargetTask(task, options.result);
}

async function executeRawTarget(options: {
  context: RawBuildContext;
  target: TypecheckTarget;
}): Promise<TypecheckTargetResult[]> {
  const tasks = new Map<CheckerTargetId, LiminaFlowTask>();
  return runBuildTargets(
    [options.target],
    [],
    resolveTypecheckRunner(options.context.options),
    {
      config: options.context.options.config,
      onTargetResult: (target, result) =>
        completeRawTargetTask({ result, target, tasks }),
      onTargetStart: (target) =>
        startRawTargetTask({ context: options.context, target, tasks }),
      watch: options.context.options.watch,
    },
  );
}

function reportRawBuildFailure(options: {
  context: RawBuildContext;
  failedResults: readonly TypecheckTargetResult[];
}): boolean {
  if (options.failedResults.length === 0) return false;
  if (shouldLogCheckReport(options.context.options.report)) {
    TypecheckLogger.error(
      formatFailedTargetSummaryReport({
        failedResults: options.failedResults,
        heading: 'build failed:',
        pluralIssueLabel: 'failed build targets',
        projectRootDir: options.context.projectRootDir,
        singularIssueLabel: 'failed build target',
        title: 'Build summary',
      }),
    );
  }
  return true;
}

function shouldReportRawBuildSuccess(context: RawBuildContext): boolean {
  if (!shouldLogCheckReport(context.options.report)) return false;
  return context.options.flow?.interactive !== true;
}

function reportRawBuildResult(options: {
  context: RawBuildContext;
  failedResults: readonly TypecheckTargetResult[];
}): void {
  if (reportRawBuildFailure(options)) return;
  if (!shouldReportRawBuildSuccess(options.context)) return;
  TypecheckLogger.success('Built 1 raw target.');
}

function createRawBuildContext(options: {
  cwd: string;
  request: RunBuildOptions;
  target: Extract<ResolvedBuildTarget, { kind: 'raw' }>;
}): RawBuildContext {
  return {
    cwd: options.cwd,
    flowDepth: options.request.flowDepth ?? 0,
    options: options.request,
    projectRootDir: normalizeAbsolutePath(options.request.config.rootDir),
    target: options.target,
  };
}

export async function runRawBuild(options: {
  cwd: string;
  request: RunBuildOptions;
  target: Extract<ResolvedBuildTarget, { kind: 'raw' }>;
}): Promise<RunBuildResult> {
  const context = createRawBuildContext(options);
  const { checker, target } = createRawTarget(context);
  const peerFailure = createPeerDependencyFailure({
    context,
    problems: collectCheckerPeerDependencyProblems({
      checkers: [checker],
      imports: context.options.config.config?.imports,
      projectRootDir: context.projectRootDir,
      resolvePackage: context.options.checkerPackageResolver,
    }),
  });
  if (peerFailure !== null) return peerFailure;
  logRawBuildStart(context);
  const results = await executeRawTarget({ context, target });
  const failedResults = results.filter((result) => result.status !== 0);
  reportRawBuildResult({ context, failedResults });
  return {
    failedTargets: collectFailedCheckerTargets([target], failedResults),
    passed: failedResults.length === 0,
    projectRootDir: context.projectRootDir,
    rootConfigPaths: [context.target.targetConfigPath],
    sourceConfigPath: null,
  };
}
