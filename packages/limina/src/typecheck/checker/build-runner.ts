import type { ResolvedCheckerConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import {
  assertProducerBuildReceipt,
  captureProducerBuildInputs,
  issueProducerBuildReceipt,
  type ProducerBuildReceipt,
} from '../../core/build-graph/producer-receipt';
import type { PreparedTsconfigGraph } from '../../core/build-graph/types';
import { measureGraphMaterialization } from '../../execution/graph-materialization-progress';
import { measureTaskProgress } from '../../execution/progress';
import { TypecheckLogger } from '../../logger';
import { resolvePreflight } from '../../preflight';
import { shouldLogCheckReport } from '../runner-shared';
import type {
  RunCheckerBuildOptions,
  RunCheckerBuildResult,
} from '../runner-types';
import { getExecutionCheckers } from '../targets';
import {
  executeCheckerBuildTargets,
  reportCheckerBuildExecution,
} from './build-execution';
import {
  createGeneratedCheckerBuildTargets,
  createManagedCheckerBuildTargets,
  selectManagedCheckerBuildTargets,
} from './build-selection';
import {
  createCheckerBuildPeerFailure,
  createCheckerBuildSelectionFailure,
  getCheckerBuildPeerProblems,
} from './build-validation';

interface CheckerBuildContext {
  allCheckers: readonly ResolvedCheckerConfig[];
  buildCheckers: readonly ResolvedCheckerConfig[];
  cwd: string;
  flowDepth: number;
  generatedGraph: PreparedTsconfigGraph;
  options: RunCheckerBuildOptions;
  preflight: ReturnType<typeof resolvePreflight>;
  projectRootDir: string;
  workspaceContext: Awaited<
    ReturnType<ReturnType<typeof resolvePreflight>['ensureWorkspaceValidated']>
  >;
}

function createResult(options: {
  context: CheckerBuildContext;
  execution: Awaited<ReturnType<typeof executeCheckerBuildTargets>>;
  rootConfigPaths: string[];
}): RunCheckerBuildResult {
  return {
    failedTargets: options.execution.failedTargets,
    failureKind: options.execution.failureKind,
    passed: options.execution.passed,
    projectRootDir: options.context.projectRootDir,
    rootConfigPaths: options.rootConfigPaths,
    targetOutcomes: options.execution.targetOutcomes,
    targetResults: options.execution.results,
  };
}

function logGeneratedBuildStart(options: {
  context: CheckerBuildContext;
  rootConfigPaths: readonly string[];
  targetCount: number;
}): void {
  options.context.options.flow?.info(
    `found ${options.targetCount} checker build entry(s)`,
    { depth: options.context.flowDepth + 1 },
  );
  if (!shouldLogCheckReport(options.context.options.report)) return;
  TypecheckLogger.info(
    [
      `Running build checks for ${options.targetCount} checker entry(s).`,
      `CWD: ${toRelativePath(
        options.context.cwd,
        options.context.projectRootDir,
      )}`,
      `Entries: ${options.rootConfigPaths
        .map((configPath) =>
          toRelativePath(options.context.projectRootDir, configPath),
        )
        .join(', ')}`,
    ].join('\n'),
  );
}

function getExplicitConfigPath(context: CheckerBuildContext): string {
  const configPath = context.options.configPath;
  if (configPath !== undefined) return configPath;
  throw new Error('Expected an explicit checker build config path.');
}

function reportSelectedTargetCount(
  context: CheckerBuildContext,
  count: number,
): void {
  context.options.flow?.info(`found ${count} checker build target(s)`, {
    depth: context.flowDepth + 1,
  });
}

function planSelectedBuildTargets(
  context: CheckerBuildContext,
  configPath: string,
) {
  return measureTaskProgress(
    context.options.progress,
    'plan build targets',
    () => {
      const selection = selectManagedCheckerBuildTargets({
        allCheckers: context.allCheckers,
        checker: context.options.checker,
        configPath,
        cwd: context.cwd,
        generatedGraph: context.generatedGraph,
        projectRootDir: context.projectRootDir,
      });
      if (selection.kind === 'problem') {
        return {
          failure: createCheckerBuildSelectionFailure({
            problem: selection.problem,
            projectRootDir: context.projectRootDir,
            report: context.options.report,
          }),
          kind: 'failed' as const,
        };
      }
      const problems = getCheckerBuildPeerProblems({
        checkers: selection.selected.map(({ checker }) => checker),
        projectRootDir: context.projectRootDir,
        request: context.options,
      });
      const peerFailure = createCheckerBuildPeerFailure({
        flowDepth: context.flowDepth,
        problems,
        projectRootDir: context.projectRootDir,
        request: context.options,
      });
      if (peerFailure !== null) {
        return { failure: peerFailure, kind: 'failed' as const };
      }
      return {
        kind: 'planned' as const,
        targets: createManagedCheckerBuildTargets({
          commandOverride: context.options.tscCommand,
          projectRootDir: context.projectRootDir,
          selected: selection.selected,
          watch: context.options.watch,
        }),
      };
    },
    (result) => result.kind === 'planned',
  );
}

async function runSelectedCheckerBuild(
  context: CheckerBuildContext,
): Promise<RunCheckerBuildResult> {
  const configPath = getExplicitConfigPath(context);
  const planned = await planSelectedBuildTargets(context, configPath);
  if (planned.kind === 'failed') return planned.failure;
  const { targets } = planned;
  const rootConfigPaths = targets.map((target) => target.configPath);
  reportSelectedTargetCount(context, targets.length);
  const execution = await executeCheckerBuildTargets({
    allCheckers: context.allCheckers,
    config: context.options.config,
    flowDepth: context.flowDepth,
    generatedGraph: context.generatedGraph,
    label: 'checker build',
    preflight: context.preflight,
    projectRootDir: context.projectRootDir,
    runnerOptions: context.options,
    targets,
    watch: context.options.watch,
    workspaceContext: context.workspaceContext,
  });
  reportCheckerBuildExecution({
    execution,
    projectRootDir: context.projectRootDir,
    report: context.options.report,
    runnerOptions: context.options,
    successLabel: 'target',
    targetCount: targets.length,
  });
  return createResult({ context, execution, rootConfigPaths });
}

function planGeneratedBuildTargets(context: CheckerBuildContext) {
  return measureTaskProgress(
    context.options.progress,
    'plan build targets',
    () => {
      const problems = getCheckerBuildPeerProblems({
        checkers: context.buildCheckers,
        projectRootDir: context.projectRootDir,
        request: context.options,
      });
      const peerFailure = createCheckerBuildPeerFailure({
        flowDepth: context.flowDepth,
        problems,
        projectRootDir: context.projectRootDir,
        request: context.options,
      });
      if (peerFailure !== null) {
        return { failure: peerFailure, kind: 'failed' as const };
      }
      return {
        kind: 'planned' as const,
        targets: createGeneratedCheckerBuildTargets({
          checkers: context.buildCheckers,
          commandOverride: context.options.tscCommand,
          generatedGraph: context.generatedGraph,
          projectRootDir: context.projectRootDir,
        }),
      };
    },
    (result) => result.kind === 'planned',
  );
}

async function runGeneratedCheckerBuild(
  context: CheckerBuildContext,
): Promise<RunCheckerBuildResult> {
  const planned = await planGeneratedBuildTargets(context);
  if (planned.kind === 'failed') return planned.failure;
  const { targets } = planned;
  const rootConfigPaths = targets.map((target) => target.configPath);
  logGeneratedBuildStart({
    context,
    rootConfigPaths,
    targetCount: targets.length,
  });
  const execution = await executeCheckerBuildTargets({
    allCheckers: context.allCheckers,
    config: context.options.config,
    flowDepth: context.flowDepth,
    generatedGraph: context.generatedGraph,
    label: 'checker build',
    preflight: context.preflight,
    projectRootDir: context.projectRootDir,
    runnerOptions: context.options,
    targets,
    watch: undefined,
    workspaceContext: context.workspaceContext,
  });
  reportCheckerBuildExecution({
    execution,
    projectRootDir: context.projectRootDir,
    report: context.options.report,
    runnerOptions: context.options,
    successLabel: 'entry',
    targetCount: targets.length,
  });
  return createResult({ context, execution, rootConfigPaths });
}

async function createCheckerBuildContext(
  options: RunCheckerBuildOptions,
  purpose: PreparedTsconfigGraph['purpose'] = 'complete',
): Promise<CheckerBuildContext> {
  const preflight = resolvePreflight(options.config, options);
  const executionPurpose = options.watch ? 'complete' : purpose;
  const existingGraph =
    executionPurpose === 'complete'
      ? preflight.getMaterializedGraph()
      : preflight.getMaterializedProducerGraph();
  const { graph: generatedGraph } =
    existingGraph === undefined
      ? await measureGraphMaterialization({
          progress: options.progress,
          purpose: executionPurpose,
          materialize: (onAccess) =>
            preflight.ensureExecutionArtifactsMaterialized(
              executionPurpose,
              onAccess,
            ),
        })
      : { graph: existingGraph };
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const allCheckers = generatedGraph.checkers;
  return {
    allCheckers,
    buildCheckers: getExecutionCheckers({
      checkers: allCheckers,
      executionKind: 'build',
    }),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    flowDepth: options.flowDepth ?? 0,
    generatedGraph,
    options,
    preflight,
    projectRootDir: normalizeAbsolutePath(options.config.rootDir),
    workspaceContext,
  };
}

export async function runCheckerBuildImpl(
  options: RunCheckerBuildOptions,
): Promise<RunCheckerBuildResult> {
  if (options.watch) return runBuild(options);
  const preflight = resolvePreflight(options.config, options);
  const hasSvelteCheckProjects = await preflight.hasSvelteCheckProjects();
  if (!hasSvelteCheckProjects) return runBuild({ ...options, preflight });
  if (options.configPath !== undefined)
    return runSelectedCheckerBuild(
      await createCheckerBuildContext(
        { ...options, preflight },
        'producer-build',
      ),
    );
  const built = await ensureBuilt({ ...options, preflight });
  const { receipt } = built;
  if (
    receipt !== undefined &&
    (receipt.plan.governedSources.get('svelte-check')?.size ?? 0) > 0
  ) {
    await measureTaskProgress(
      options.progress,
      'prepare Svelte consumer inputs',
      () => preflight.prepareConsumerPhase(receipt),
    );
    await measureGraphMaterialization({
      materialize: (onAccess) =>
        preflight.ensureGeneratedArtifactsMaterialized(onAccess),
      progress: options.progress,
      purpose: 'complete',
    });
  }
  return built.reused
    ? {
        ...built.result,
        targetResults: [],
        targetOutcomes: [],
        reusedTargetResults: built.result.targetResults,
      }
    : built.result;
}

async function runBuild(
  options: RunCheckerBuildOptions,
): Promise<RunCheckerBuildResult> {
  const context = await createCheckerBuildContext(options);
  return options.configPath === undefined
    ? runGeneratedCheckerBuild(context)
    : runSelectedCheckerBuild(context);
}

interface BuiltProducers {
  reused: boolean;
  result: RunCheckerBuildResult;
  receipt?: ProducerBuildReceipt;
}
interface ProducerBuildAttempt {
  promise: Promise<BuiltProducers>;
  settled: boolean;
}
const builds = new WeakMap<
  ReturnType<typeof resolvePreflight>,
  ProducerBuildAttempt
>();
const buildCommands = new WeakMap<
  ReturnType<typeof resolvePreflight>,
  string | undefined
>();
const buildGenerations = new WeakMap<
  ReturnType<typeof resolvePreflight>,
  unknown
>();

export async function ensureBuilt(
  options: RunCheckerBuildOptions,
): Promise<BuiltProducers> {
  const preflight = resolvePreflight(options.config, options);
  if (
    buildGenerations.get(preflight) !== preflight.run.generation ||
    buildCommands.get(preflight) !== options.tscCommand
  ) {
    builds.delete(preflight);
    buildCommands.set(preflight, options.tscCommand);
    buildGenerations.set(preflight, preflight.run.generation);
  }
  const existing = builds.get(preflight);
  if (existing !== undefined) {
    return measureTaskProgress(
      options.progress,
      existing.settled
        ? 'validate reused Svelte producer receipt'
        : 'wait for Svelte producer build',
      async () => {
        const built = await existing.promise;
        if (built.receipt !== undefined)
          assertProducerBuildReceipt(built.receipt);
        return { ...built, reused: true };
      },
      (built) => built.result.passed,
    );
  }
  const generation = preflight.run.generation;
  const assertBuildGeneration = () => {
    if (generation !== preflight.run.generation)
      throw new Error(
        'Producer build generation changed before receipt publication.',
      );
  };
  const pending = (async () => {
    const context = await createCheckerBuildContext(
      { ...options, preflight },
      'producer-build',
    );
    const { generatedGraph: plan } = context;
    if (plan.purpose !== 'producer-build')
      throw new Error('Expected a producer build plan.');
    const baseline = await measureTaskProgress(
      options.progress,
      'capture Svelte producer inputs',
      () => captureProducerBuildInputs(plan),
    );
    const result = await runGeneratedCheckerBuild(context);
    if (!result.passed) {
      assertBuildGeneration();
      return { result, reused: false };
    }
    return {
      result,
      reused: false,
      receipt: await measureTaskProgress(
        options.progress,
        'publish Svelte producer receipt',
        () => {
          assertBuildGeneration();
          return issueProducerBuildReceipt(
            plan,
            baseline,
            context.projectRootDir,
          );
        },
      ),
    };
  })();
  const attempt: ProducerBuildAttempt = { promise: pending, settled: false };
  builds.set(preflight, attempt);
  try {
    const built = await pending;
    attempt.settled = true;
    if (!built.result.passed && builds.get(preflight) === attempt)
      builds.delete(preflight);
    return built;
  } catch (error) {
    if (builds.get(preflight) === attempt) builds.delete(preflight);
    throw error;
  }
}
