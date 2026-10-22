import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import { resolveCheckerTypecheckConcurrency } from '../../execution/config';
import { runPool } from '../../execution/pool';
import type { TaskProgressItem } from '../../execution/progress';
import type { LiminaFlowTask } from '../../flow';
import { TypecheckLogger } from '../../logger';
import { resolvePreflight } from '../../preflight';
import { ExecutionAdmission } from '../admission/execution-admission';
import { rejectedBeforeLaunch } from '../admission/reporting';
import {
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
import type { BuildTargetCompletion } from '../target-types';
import {
  type CheckerTargetId,
  createCheckerTarget,
  createFrameworkCheckerTargets,
  getExecutionCheckers,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from '../targets';
import { executeAuthorizedTypecheck } from './typecheck-execution';
import { collectTypecheckPeerFailure } from './typecheck-preflight';
import {
  createNoTypecheckCheckerResult,
  createTypecheckExecutionResult,
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

function createConfiguredTypecheckTargets(options: {
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

function createTypecheckTargets(options: {
  context: CheckerTypecheckContext;
  generatedGraph: GeneratedTsconfigGraphResult;
}): TypecheckTarget[] {
  const configuredTargets = createConfiguredTypecheckTargets(options);
  const frameworkTargets = createFrameworkCheckerTargets({
    generatedGraph: options.generatedGraph,
    workspaceRootDir: options.context.projectRootDir,
  });
  const rootConfigPaths = new Set(options.context.rootConfigPaths);
  for (const target of frameworkTargets) {
    rootConfigPaths.add(target.sourceConfigPath!);
  }
  options.context.rootConfigPaths = [...rootConfigPaths];
  return [...configuredTargets, ...frameworkTargets];
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
  admission: ExecutionAdmission;
  context: CheckerTypecheckContext;
  targets: readonly TypecheckTarget[];
}): Promise<BuildTargetCompletion[]> {
  const tasks: Map<CheckerTargetId, CheckerFlowTask> = new Map(
    createPlannedCheckerTargetTasks({
      prefix: 'checker typecheck',
      progress: options.context.options.progress,
      projectRootDir: options.context.projectRootDir,
      targets: options.targets,
    }),
  );
  const runner = resolveTypecheckRunner(options.context.options);
  return runPool<TypecheckTarget, BuildTargetCompletion>({
    concurrency: resolveCheckerTypecheckConcurrency({
      config: options.context.options.config,
      itemCount: options.targets.length,
    }),
    items: options.targets,
    onError: normalizeTargetError,
    onResult: (target, result) => {
      if (typeof result.status === 'number')
        completeTargetTask({ result, target, tasks });
      else tasks.get(target.id)?.fail();
    },
    run: async (target) => {
      try {
        startTargetTask({ context: options.context, target, tasks });
      } catch (error) {
        return rejectedBeforeLaunch(target, error);
      }
      return executeAuthorizedTypecheck(
        {
          admission: options.admission,
          signal: options.context.options.signal,
        },
        target,
        runner,
      );
    },
  });
}

function createContext(
  options: RunCheckerTypecheckOptions,
  graph: GeneratedTsconfigGraphResult,
): CheckerTypecheckContext {
  return {
    checkers: getExecutionCheckers({
      checkers: graph.checkers,
      executionKind: 'typecheck',
    }),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    flowDepth: options.flowDepth ?? 0,
    options,
    projectRootDir: normalizeAbsolutePath(options.config.rootDir),
    rootConfigPaths: [],
  };
}

async function runConfiguredTypecheck(
  options: RunCheckerTypecheckOptions,
  preflight: ReturnType<typeof resolvePreflight>,
): Promise<RunCheckerTypecheckResult> {
  const receipt = await preflight.ensureGeneratedArtifactsMaterialized();
  const context = createContext(options, receipt.graph);
  const targets = createTypecheckTargets({
    context,
    generatedGraph: receipt.graph,
  });
  if (targets.length === 0)
    return createNoTypecheckCheckerResult({
      flowDepth: context.flowDepth,
      projectRootDir: context.projectRootDir,
      request: context.options,
    });
  return runMaterializedTypecheck(
    context,
    targets,
    new ExecutionAdmission(preflight, receipt.graph, targets),
  );
}

async function runMaterializedTypecheck(
  context: CheckerTypecheckContext,
  targets: TypecheckTarget[],
  admission: ExecutionAdmission,
): Promise<RunCheckerTypecheckResult> {
  const peerFailure = collectTypecheckPeerFailure({
    checkerPackageResolver: context.options.checkerPackageResolver,
    checkers: context.checkers,
    flowDepth: context.flowDepth,
    projectRootDir: context.projectRootDir,
    request: context.options,
    targets,
  });
  if (peerFailure !== undefined) return peerFailure;
  logTypecheckStart({ context, targets });
  const completions = await executeTypecheckTargets({
    context,
    targets,
    admission,
  });
  return createTypecheckExecutionResult({
    completions,
    targets,
    request: context.options,
    projectRootDir: context.projectRootDir,
    rootConfigPaths: context.rootConfigPaths,
  });
}

export async function runCheckerTypecheckImpl(
  options: RunCheckerTypecheckOptions,
): Promise<RunCheckerTypecheckResult> {
  const preflight = resolvePreflight(options.config, options);
  await preflight.ensureWorkspaceValidated();
  return runConfiguredTypecheck(options, preflight);
}
