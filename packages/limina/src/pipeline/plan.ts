import type { ResolvedLiminaConfig } from '#config/runner';
import { validateExecutionPlan } from '../execution/executor';
import type { ExecutionPlan, ExecutionTask, TaskId } from '../execution/tasks';
import { taskId } from '../execution/tasks';
import type { LiminaPreflightManager } from '../preflight';
import {
  createFrameworkCheckerTargets,
  getExecutionCheckers,
} from '../typecheck/targets';
import {
  createBuiltinExecutionTask,
  createCommandExecutionTask,
  createCoreAnalysisTask,
  createMaterializationTask,
  createWorkspaceValidationTask,
} from './execution-tasks';
import {
  defaultCheckPipeline,
  getPipelineSteps,
  normalizePipelineStep,
} from './steps';
import type { NormalizedPipelineStep, RunPipelineOptions } from './types';

interface TaskSegment {
  command: ExecutionTask | undefined;
  generation: number;
  index: number;
  tasks: ExecutionTask[];
}

function createStepTaskId(step: NormalizedPipelineStep, index: number): TaskId {
  const suffix = step.type === 'command' ? 'command' : `task:${step.name}`;
  return taskId(`step:${index}:${suffix}`);
}

function createUserTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  index: number;
  pipelineOptions: RunPipelineOptions;
  step: NormalizedPipelineStep;
}): ExecutionTask {
  const id = createStepTaskId(options.step, options.index);
  if (options.step.type === 'task') {
    return createBuiltinExecutionTask({
      config: options.config,
      generation: options.generation,
      id,
      pipelineOptions: options.pipelineOptions,
      step: options.step,
    });
  }
  return createCommandExecutionTask({
    config: options.config,
    generation: options.generation,
    id,
    pipelineOptions: options.pipelineOptions,
    step: options.step,
  });
}

function applyOrderedDependency(options: {
  dependencyMode: 'independent' | 'ordered';
  previous: ExecutionTask | undefined;
  task: ExecutionTask;
}): void {
  if (options.dependencyMode !== 'ordered' || options.previous === undefined)
    return;
  options.task.after = [options.previous.id];
}

function createUserTasks(options: {
  config: ResolvedLiminaConfig;
  dependencyMode: 'independent' | 'ordered';
  pipelineOptions: RunPipelineOptions;
  steps: readonly NormalizedPipelineStep[];
}): ExecutionTask[] {
  const tasks: ExecutionTask[] = [];
  let generation = 0;
  for (const [index, step] of options.steps.entries()) {
    const task = createUserTask({ ...options, generation, index, step });
    applyOrderedDependency({
      dependencyMode: options.dependencyMode,
      previous: tasks.at(-1),
      task,
    });
    tasks.push(task);
    if (step.type === 'command') generation += 1;
  }
  return tasks;
}

function createSegment(options: {
  command: ExecutionTask | undefined;
  generation: number;
  index: number;
  tasks: ExecutionTask[];
}): TaskSegment {
  return { ...options };
}

interface SegmentPartitionState {
  generation: number;
  index: number;
  segments: TaskSegment[];
  tasks: ExecutionTask[];
}

function appendPartitionTask(
  state: SegmentPartitionState,
  task: ExecutionTask,
): void {
  if (task.kind !== 'command') {
    state.tasks.push(task);
    return;
  }
  state.segments.push(
    createSegment({
      command: task,
      generation: state.generation,
      index: state.index,
      tasks: state.tasks,
    }),
  );
  state.tasks = [];
  state.generation += 1;
  state.index += 1;
}

function appendFinalSegment(state: SegmentPartitionState): void {
  if (state.tasks.length === 0) return;
  state.segments.push(
    createSegment({
      command: undefined,
      generation: state.generation,
      index: state.index,
      tasks: state.tasks,
    }),
  );
}

function partitionTaskSegments(
  userTasks: readonly ExecutionTask[],
): TaskSegment[] {
  const state: SegmentPartitionState = {
    generation: 0,
    index: 0,
    segments: [],
    tasks: [],
  };
  for (const task of userTasks) appendPartitionTask(state, task);
  appendFinalSegment(state);
  return state.segments;
}

function hasPredecessors(
  predecessors: readonly TaskId[] | undefined,
): predecessors is readonly TaskId[] {
  return predecessors !== undefined && predecessors.length > 0;
}

function attachValidationPredecessors(
  validation: ExecutionTask,
  segmentTasks: readonly ExecutionTask[],
): void {
  const predecessors = segmentTasks[0]?.after;
  if (hasPredecessors(predecessors)) validation.after = [...predecessors];
}

function requireTaskSuccess(
  tasks: readonly ExecutionTask[],
  prerequisite: ExecutionTask,
): void {
  for (const task of tasks) task.requiresSuccessOf = [prerequisite.id];
}

function hasTypecheckTargets(preflight: LiminaPreflightManager): boolean {
  const graph = preflight.getMaterializedGraph();
  if (graph === undefined) return true;
  return (
    getExecutionCheckers({
      checkers: graph.checkers,
      executionKind: 'typecheck',
    }).length > 0 ||
    createFrameworkCheckerTargets({
      generatedGraph: graph,
      workspaceRootDir: preflight.config.rootDir,
    }).length > 0
  );
}

function appendDefaultTasks(options: {
  config: ResolvedLiminaConfig;
  output: ExecutionTask[];
  segment: TaskSegment;
  validation: ExecutionTask;
}): void {
  const builds = options.segment.tasks.filter(
    (task) => task.issueTask === 'checker:build',
  );
  const checks = options.segment.tasks.filter(
    (task) => task.issueTask !== 'checker:build',
  );
  const coreAnalysis = createCoreAnalysisTask({
    config: options.config,
    generation: options.segment.generation,
    segment: options.segment.index,
  });
  coreAnalysis.requiresSuccessOf = [options.validation.id];
  const materialization = createMaterializationTask({
    generation: options.segment.generation,
    segment: options.segment.index,
  });
  materialization.requiresSuccessOf = [coreAnalysis.id];
  requireTaskSuccess(builds, materialization);
  requireTaskSuccess(checks, materialization);
  const buildIds = builds.map((task) => task.id);
  if (buildIds.length > 0) {
    for (const check of checks) {
      check.requiresSuccessOfWhen = {
        tasks: buildIds,
        test: (preflight) =>
          preflight.requiresPostBuildGraphFinalization() ||
          (check.issueTask === 'checker:typecheck' &&
            hasTypecheckTargets(preflight)),
        waitOnlyWhenMatched: true,
      };
    }
  }
  options.output.push(coreAnalysis, materialization, ...builds, ...checks);
}

function appendBuiltinTasks(options: {
  config: ResolvedLiminaConfig;
  dependencyMode: 'independent' | 'ordered';
  output: ExecutionTask[];
  segment: TaskSegment;
}): void {
  if (options.segment.tasks.length === 0) return;
  const validation = createWorkspaceValidationTask({
    config: options.config,
    generation: options.segment.generation,
    segment: options.segment.index,
  });
  attachValidationPredecessors(validation, options.segment.tasks);
  requireTaskSuccess(options.segment.tasks, validation);
  options.output.push(validation);
  if (options.dependencyMode === 'independent') {
    appendDefaultTasks({ ...options, validation });
  } else {
    options.output.push(...options.segment.tasks);
  }
}

function appendSegment(options: {
  config: ResolvedLiminaConfig;
  dependencyMode: 'independent' | 'ordered';
  output: ExecutionTask[];
  segment: TaskSegment;
}): void {
  appendBuiltinTasks(options);
  if (options.segment.command !== undefined) {
    options.output.push(options.segment.command);
  }
}

function assignTaskOrder(tasks: readonly ExecutionTask[]): void {
  for (const [order, task] of tasks.entries()) task.order = order;
}

function buildExecutionPlan(options: {
  config: ResolvedLiminaConfig;
  dependencyMode: 'independent' | 'ordered';
  pipelineOptions: RunPipelineOptions;
  steps: readonly NormalizedPipelineStep[];
}): ExecutionPlan {
  const userTasks = createUserTasks(options);
  const tasks: ExecutionTask[] = [];
  for (const segment of partitionTaskSegments(userTasks)) {
    appendSegment({
      config: options.config,
      dependencyMode: options.dependencyMode,
      output: tasks,
      segment,
    });
  }
  assignTaskOrder(tasks);
  const plan = { tasks, userTaskCount: userTasks.length };
  validateExecutionPlan(plan);
  return plan;
}

export function createExecutionPlan(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): ExecutionPlan {
  return buildExecutionPlan({
    config,
    dependencyMode: 'ordered',
    pipelineOptions: options,
    steps: getPipelineSteps(config, pipelineName).map(normalizePipelineStep),
  });
}

export function createDefaultExecutionPlan(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): ExecutionPlan {
  return buildExecutionPlan({
    config,
    dependencyMode: 'independent',
    pipelineOptions: options,
    steps: defaultCheckPipeline.map(normalizePipelineStep),
  });
}
