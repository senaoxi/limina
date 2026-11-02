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

async function runSelectedCheckerBuild(
  context: CheckerBuildContext,
): Promise<RunCheckerBuildResult> {
  const configPath = getExplicitConfigPath(context);
  const selection = selectManagedCheckerBuildTargets({
    allCheckers: context.allCheckers,
    checker: context.options.checker,
    configPath,
    cwd: context.cwd,
    generatedGraph: context.generatedGraph,
    projectRootDir: context.projectRootDir,
  });
  if (selection.kind === 'problem') {
    return createCheckerBuildSelectionFailure({
      problem: selection.problem,
      projectRootDir: context.projectRootDir,
      report: context.options.report,
    });
  }
  const peerFailure = createCheckerBuildPeerFailure({
    flowDepth: context.flowDepth,
    problems: getCheckerBuildPeerProblems({
      checkers: selection.selected.map(({ checker }) => checker),
      projectRootDir: context.projectRootDir,
      request: context.options,
    }),
    projectRootDir: context.projectRootDir,
    request: context.options,
  });
  if (peerFailure !== null) return peerFailure;
  const targets = createManagedCheckerBuildTargets({
    commandOverride: context.options.tscCommand,
    projectRootDir: context.projectRootDir,
    selected: selection.selected,
    watch: context.options.watch,
  });
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

async function runGeneratedCheckerBuild(
  context: CheckerBuildContext,
): Promise<RunCheckerBuildResult> {
  const peerFailure = createCheckerBuildPeerFailure({
    flowDepth: context.flowDepth,
    problems: getCheckerBuildPeerProblems({
      checkers: context.buildCheckers,
      projectRootDir: context.projectRootDir,
      request: context.options,
    }),
    projectRootDir: context.projectRootDir,
    request: context.options,
  });
  if (peerFailure !== null) return peerFailure;
  const targets = createGeneratedCheckerBuildTargets({
    checkers: context.buildCheckers,
    commandOverride: context.options.tscCommand,
    generatedGraph: context.generatedGraph,
    projectRootDir: context.projectRootDir,
  });
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
  const generated = await preflight.ensureExecutionArtifactsMaterialized(
    options.watch ? 'complete' : purpose,
  );
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const allCheckers = generated.graph.checkers;
  return {
    allCheckers,
    buildCheckers: getExecutionCheckers({
      checkers: allCheckers,
      executionKind: 'build',
    }),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    flowDepth: options.flowDepth ?? 0,
    generatedGraph: generated.graph,
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
  if (!(await preflight.hasSvelteCheckProjects()))
    return runBuild({ ...options, preflight });
  if (options.configPath !== undefined)
    return runSelectedCheckerBuild(
      await createCheckerBuildContext(
        { ...options, preflight },
        'producer-build',
      ),
    );
  const built = await ensureBuilt({ ...options, preflight });
  if (
    built.receipt !== undefined &&
    (built.receipt.plan.governedSources.get('svelte-check')?.size ?? 0) > 0
  )
    await preflight.prepareConsumerPhase(built.receipt);
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
const builds = new WeakMap<
  ReturnType<typeof resolvePreflight>,
  Promise<BuiltProducers>
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
    const built = await existing;
    if (built.receipt !== undefined) assertProducerBuildReceipt(built.receipt);
    return { ...built, reused: true };
  }
  const generation = preflight.run.generation;
  const pending = (async () => {
    const context = await createCheckerBuildContext(
      { ...options, preflight },
      'producer-build',
    );
    if (context.generatedGraph.purpose !== 'producer-build')
      throw new Error('Expected a producer build plan.');
    const baseline = captureProducerBuildInputs(context.generatedGraph);
    const result = await runGeneratedCheckerBuild(context);
    if (generation !== preflight.run.generation)
      throw new Error(
        'Producer build generation changed before receipt publication.',
      );
    if (!result.passed) return { result, reused: false };
    return {
      result,
      reused: false,
      receipt: issueProducerBuildReceipt(
        context.generatedGraph,
        baseline,
        context.projectRootDir,
      ),
    };
  })();
  builds.set(preflight, pending);
  try {
    const built = await pending;
    if (!built.result.passed && builds.get(preflight) === pending)
      builds.delete(preflight);
    return built;
  } catch (error) {
    if (builds.get(preflight) === pending) builds.delete(preflight);
    throw error;
  }
}
