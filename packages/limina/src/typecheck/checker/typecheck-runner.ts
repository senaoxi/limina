import { formatMissingCheckerPeerDependencies } from '#checkers';
import { getActiveCheckers } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import { resolveCheckerTypecheckConcurrency } from '../../execution/config';
import { runPool } from '../../execution/pool';
import type { TaskProgressItem } from '../../execution/progress';
import type { LiminaFlowTask } from '../../flow';
import { TypecheckLogger } from '../../logger';
import { resolvePreflight } from '../../preflight';
import {
  collectFailedCheckerTargets,
  completeCheckerTargetTask,
  createPlannedCheckerTargetTasks,
  getCheckerTargetFlowLabel,
  resolveTypecheckRunner,
  shouldLogCheckReport,
} from '../runner-shared';
import type {
  RunCheckerTypecheckOptions,
  RunCheckerTypecheckResult,
} from '../runner-types';
import {
  type CheckerTargetId,
  collectCheckerPeerDependencyDetails,
  createCheckerTarget,
  getExecutionCheckers,
  runTargetWithMeasuredDuration,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from '../targets';
import { VueTsgoCacheBatchCoordinator } from '../vue-tsgo-cache';
import {
  createNoTypecheckCheckerResult,
  createTypecheckPeerFailure,
  reportTypecheckResult,
} from './typecheck-reporting';

type CheckerFlowTask = LiminaFlowTask | TaskProgressItem;

type TypecheckCheckers = ReturnType<typeof getExecutionCheckers>;

interface CheckerTypecheckContext {
  checkers: TypecheckCheckers;
  cwd: string;
  flowDepth: number;
  options: RunCheckerTypecheckOptions;
  projectRootDir: string;
  rootConfigPaths: string[];
}

function createTypecheckTargets(options: {
  context: CheckerTypecheckContext;
  generatedGraph: GeneratedTsconfigGraphResult;
}): TypecheckTarget[] {
  return options.context.checkers.map((checker) => {
    const configPath = options.generatedGraph.checkerEntries.get(checker.name);
    if (configPath === undefined) {
      throw new Error(`Missing generated entry for checker "${checker.name}".`);
    }
    options.context.rootConfigPaths.push(configPath);
    return createCheckerTarget({
      checker,
      commandOverride: options.context.options.tscCommand,
      configPath,
      executionKind: 'typecheck',
      projectRootDir: options.context.projectRootDir,
    });
  });
}

function logTypecheckStart(options: {
  context: CheckerTypecheckContext;
  targets: readonly TypecheckTarget[];
}): void {
  options.context.options.flow?.info(
    `found ${options.targets.length} checker typecheck entry(s)`,
    { depth: options.context.flowDepth + 1 },
  );
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.info(
    [
      `Running typecheck for ${options.targets.length} checker entry(s).`,
      `CWD: ${toRelativePath(
        options.context.cwd,
        options.context.projectRootDir,
      )}`,
      `Entries: ${options.context.rootConfigPaths
        .map((configPath) =>
          toRelativePath(options.context.projectRootDir, configPath),
        )
        .join(', ')}`,
    ].join('\n'),
  );
}

function startProgressTask(options: {
  target: TypecheckTarget;
  tasks: ReadonlyMap<CheckerTargetId, CheckerFlowTask>;
}): void {
  const task = options.tasks.get(options.target.id);
  if (task !== undefined) (task as TaskProgressItem).start();
}

function startFlowTask(options: {
  context: CheckerTypecheckContext;
  target: TypecheckTarget;
  tasks: Map<CheckerTargetId, CheckerFlowTask>;
}): void {
  const flow = options.context.options.flow;
  if (flow === undefined) return;
  options.tasks.set(
    options.target.id,
    flow.start(
      getCheckerTargetFlowLabel({
        prefix: 'checker typecheck',
        projectRootDir: options.context.projectRootDir,
        target: options.target,
      }),
      {
        collapseOnSuccess: false,
        depth: options.context.flowDepth + 1,
      },
    ),
  );
}

function startTargetTask(options: {
  context: CheckerTypecheckContext;
  target: TypecheckTarget;
  tasks: Map<CheckerTargetId, CheckerFlowTask>;
}): void {
  if (options.context.options.progress !== undefined) {
    startProgressTask(options);
    return;
  }
  startFlowTask(options);
}

function completeTargetTask(options: {
  result: TypecheckTargetResult;
  target: TypecheckTarget;
  tasks: ReadonlyMap<CheckerTargetId, CheckerFlowTask>;
}): void {
  const task = options.tasks.get(options.target.id);
  if (task !== undefined) completeCheckerTargetTask(task, options.result);
}

function normalizeTargetError(
  target: TypecheckTarget,
  error: unknown,
): TypecheckTargetResult {
  return {
    configPath: target.configPath,
    durationMs: 0,
    error: error instanceof Error ? error : new Error(String(error)),
    id: target.id,
    status: 1,
  };
}

async function executeTypecheckTargets(options: {
  context: CheckerTypecheckContext;
  targets: readonly TypecheckTarget[];
}): Promise<TypecheckTargetResult[]> {
  const tasks: Map<CheckerTargetId, CheckerFlowTask> = new Map(
    createPlannedCheckerTargetTasks({
      prefix: 'checker typecheck',
      progress: options.context.options.progress,
      projectRootDir: options.context.projectRootDir,
      targets: options.targets,
    }),
  );
  const runner = resolveTypecheckRunner(options.context.options);
  const cacheCoordinator = await VueTsgoCacheBatchCoordinator.prepare(
    options.targets,
  );
  return runPool<TypecheckTarget, TypecheckTargetResult>({
    concurrency: resolveCheckerTypecheckConcurrency({
      config: options.context.options.config,
      itemCount: options.targets.length,
    }),
    items: options.targets,
    onError: normalizeTargetError,
    onResult: (target, result) => completeTargetTask({ result, target, tasks }),
    run: async (target) => {
      await cacheCoordinator.beforeTargetRun(target);
      startTargetTask({ context: options.context, target, tasks });
      return runTargetWithMeasuredDuration(runner, target);
    },
  });
}

function createContext(
  options: RunCheckerTypecheckOptions,
): CheckerTypecheckContext {
  return {
    checkers: getExecutionCheckers({
      checkers: getActiveCheckers(options.config),
      executionKind: 'typecheck',
    }),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    flowDepth: options.flowDepth ?? 0,
    options,
    projectRootDir: normalizeAbsolutePath(options.config.rootDir),
    rootConfigPaths: [],
  };
}

function collectTypecheckPeerFailure(
  context: CheckerTypecheckContext,
): RunCheckerTypecheckResult | undefined {
  const peerDependencies = collectCheckerPeerDependencyDetails({
    checkers: context.checkers,
    imports: context.options.config.config?.imports,
    projectRootDir: context.projectRootDir,
    resolvePackage: context.options.checkerPackageResolver,
  });
  if (peerDependencies.length === 0) return undefined;
  return createTypecheckPeerFailure({
    checkerNames: [
      ...new Set(
        peerDependencies.flatMap((dependency) => dependency.checkerNames),
      ),
    ].sort(),
    flowDepth: context.flowDepth,
    problems: [formatMissingCheckerPeerDependencies(peerDependencies)],
    projectRootDir: context.projectRootDir,
    request: context.options,
  });
}

async function runConfiguredTypecheck(
  context: CheckerTypecheckContext,
  preflight: ReturnType<typeof resolvePreflight>,
): Promise<RunCheckerTypecheckResult> {
  const peerFailure = collectTypecheckPeerFailure(context);
  if (peerFailure !== undefined) return peerFailure;
  const generated = await preflight.ensureGeneratedArtifactsMaterialized();
  const targets = createTypecheckTargets({
    context,
    generatedGraph: generated.graph,
  });
  logTypecheckStart({ context, targets });
  const results = await executeTypecheckTargets({ context, targets });
  const failedResults = results.filter((result) => result.status !== 0);
  reportTypecheckResult({
    failedResults,
    projectRootDir: context.projectRootDir,
    request: context.options,
    targetCount: targets.length,
  });
  return {
    failedTargets: collectFailedCheckerTargets(targets, failedResults),
    passed: failedResults.length === 0,
    projectRootDir: context.projectRootDir,
    rootConfigPaths: context.rootConfigPaths,
    targetResults: results,
  };
}

export async function runCheckerTypecheckImpl(
  options: RunCheckerTypecheckOptions,
): Promise<RunCheckerTypecheckResult> {
  const preflight = resolvePreflight(options.config, options);
  await preflight.ensureWorkspaceValidated();
  const context = createContext(options);
  if (context.checkers.length === 0) {
    return createNoTypecheckCheckerResult({
      flowDepth: context.flowDepth,
      projectRootDir: context.projectRootDir,
      request: context.options,
    });
  }
  return runConfiguredTypecheck(context, preflight);
}
