import type { BuiltinTaskName, ResolvedLiminaConfig } from '#config/runner';
import { validateExecutionPlan } from '../execution/executor';
import type { ExecutionPlan, ExecutionTask, TaskId } from '../execution/tasks';
import { taskId } from '../execution/tasks';
import {
  createBuiltinExecutionTask,
  createCommandExecutionTask,
  createMaterializationTask,
  createWorkspaceValidationTask,
  filesystemDependentTasks,
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
  if (options.dependencyMode !== 'ordered') return;
  if (options.previous === undefined) return;
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
  if (predecessors === undefined) return false;
  return predecessors.length > 0;
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

function isFilesystemDependentTask(task: ExecutionTask): boolean {
  if (task.kind !== 'task') return false;
  return filesystemDependentTasks.has(task.issueTask as BuiltinTaskName);
}

function addPreparationTasks(options: {
  config: ResolvedLiminaConfig;
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
  const dependentTasks = options.segment.tasks.filter(
    isFilesystemDependentTask,
  );
  if (dependentTasks.length === 0) return;
  const materialization = createMaterializationTask({
    generation: options.segment.generation,
    segment: options.segment.index,
  });
  materialization.after = [validation.id];
  materialization.requiresSuccessOf = [validation.id];
  requireTaskSuccess(dependentTasks, materialization);
  options.output.push(materialization);
}

function appendSegment(options: {
  config: ResolvedLiminaConfig;
  output: ExecutionTask[];
  segment: TaskSegment;
}): void {
  addPreparationTasks(options);
  options.output.push(...options.segment.tasks);
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
    appendSegment({ config: options.config, output: tasks, segment });
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
