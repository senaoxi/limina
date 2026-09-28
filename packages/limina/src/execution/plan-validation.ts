import type { ExecutionPlan, ExecutionTask, TaskId } from './tasks';

function assertNonEmptyPlan(plan: ExecutionPlan): void {
  if (plan.tasks.length === 0) {
    throw new Error('Execution plan must contain at least one task.');
  }
}

function assertUniqueTaskIds(plan: ExecutionPlan): Set<TaskId> {
  const ids = new Set(plan.tasks.map((task) => task.id));
  if (ids.size !== plan.tasks.length) {
    throw new Error('Execution plan contains duplicate task ids.');
  }
  return ids;
}

function getDependencies(task: ExecutionTask): TaskId[] {
  return [...(task.after ?? []), ...(task.requiresSuccessOf ?? [])];
}

function assertValidGeneration(task: ExecutionTask): void {
  if (!Number.isInteger(task.generation) || task.generation < 0) {
    throw new Error(
      `Execution task "${task.label}" has invalid generation "${task.generation}".`,
    );
  }
}

function assertDependencyExists(options: {
  dependency: TaskId;
  ids: ReadonlySet<TaskId>;
  task: ExecutionTask;
}): void {
  if (!options.ids.has(options.dependency)) {
    throw new Error(
      `Execution task "${options.task.label}" references missing dependency "${options.dependency}".`,
    );
  }
  if (options.dependency === options.task.id) {
    throw new Error(
      `Execution task "${options.task.label}" depends on itself.`,
    );
  }
}

function assertDependencyGeneration(options: {
  byId: ReadonlyMap<TaskId, ExecutionTask>;
  dependency: TaskId;
  task: ExecutionTask;
}): void {
  const dependencyTask = options.byId.get(options.dependency)!;
  if (dependencyTask.generation > options.task.generation) {
    throw new Error(
      `Execution task "${options.task.label}" depends on future generation task "${dependencyTask.label}".`,
    );
  }
}

function assertTaskDependencies(options: {
  byId: ReadonlyMap<TaskId, ExecutionTask>;
  ids: ReadonlySet<TaskId>;
  task: ExecutionTask;
}): void {
  for (const dependency of getDependencies(options.task)) {
    assertDependencyExists({ ...options, dependency });
    assertDependencyGeneration({
      byId: options.byId,
      dependency,
      task: options.task,
    });
  }
}

function collectGenerations(options: {
  byId: ReadonlyMap<TaskId, ExecutionTask>;
  ids: ReadonlySet<TaskId>;
  orderedTasks: readonly ExecutionTask[];
}): number[] {
  const generations = new Set<number>();
  let previousGeneration = -1;
  for (const task of options.orderedTasks) {
    assertValidGeneration(task);
    if (task.generation < previousGeneration) {
      throw new Error('Execution plan generations must not decrease by order.');
    }
    previousGeneration = task.generation;
    generations.add(task.generation);
    assertTaskDependencies({ ...options, task });
  }
  return [...generations].sort((left, right) => left - right);
}

function assertGenerationStart(generations: readonly number[]): void {
  if (generations[0] !== 0) {
    throw new Error('Execution plan generations must start at 0.');
  }
}

function findGenerationGap(generations: readonly number[]): number | undefined {
  return generations.find((generation, index) => generation !== index);
}

function assertContinuousGenerations(generations: readonly number[]): void {
  assertGenerationStart(generations);
  if (findGenerationGap(generations) !== undefined) {
    throw new Error('Execution plan generations must be continuous.');
  }
}

function getGenerationTasks(
  orderedTasks: readonly ExecutionTask[],
  generation: number,
): ExecutionTask[] {
  return orderedTasks.filter((task) => task.generation === generation);
}

function assertAdvancementCommand(options: {
  advancementTask: ExecutionTask;
  generation: number;
}): void {
  if (options.advancementTask.kind !== 'command') {
    throw new Error(
      `Execution generation ${options.generation} advancement must be a stop-pipeline command.`,
    );
  }
  if (options.advancementTask.failPolicy !== 'stop-pipeline') {
    throw new Error(
      `Execution generation ${options.generation} advancement must be a stop-pipeline command.`,
    );
  }
}

function assertAdvancementTaskShape(options: {
  advancementTask: ExecutionTask;
  generation: number;
  segmentTasks: readonly ExecutionTask[];
}): void {
  assertAdvancementCommand(options);
  if (options.segmentTasks.at(-1)?.id !== options.advancementTask.id) {
    throw new Error(
      `Execution generation ${options.generation} advancement command must be the final task in its generation.`,
    );
  }
}

function assertSingleAdvancement(options: {
  advancementTasks: readonly ExecutionTask[];
  generation: number;
}): void {
  if (options.advancementTasks.length > 1) {
    throw new Error(
      `Execution generation ${options.generation} contains multiple advancement commands.`,
    );
  }
}

function assertRequiredAdvancement(options: {
  advancementTasks: readonly ExecutionTask[];
  generation: number;
  maximumGeneration: number;
}): void {
  if (options.generation >= options.maximumGeneration) return;
  if (options.advancementTasks.length !== 1) {
    throw new Error(
      `Execution generation ${options.generation} requires exactly one advancement command.`,
    );
  }
}

function assertAdvancementCount(options: {
  advancementTasks: readonly ExecutionTask[];
  generation: number;
  maximumGeneration: number;
}): void {
  assertSingleAdvancement(options);
  assertRequiredAdvancement(options);
}

function assertGenerationAdvancement(options: {
  generation: number;
  maximumGeneration: number;
  orderedTasks: readonly ExecutionTask[];
}): void {
  const segmentTasks = getGenerationTasks(
    options.orderedTasks,
    options.generation,
  );
  const advancementTasks = segmentTasks.filter(
    (task) => task.invalidatesPreflight === true,
  );
  assertAdvancementCount({ ...options, advancementTasks });
  const advancementTask = advancementTasks[0];
  if (advancementTask === undefined) return;
  assertAdvancementTaskShape({
    advancementTask,
    generation: options.generation,
    segmentTasks,
  });
}

function assertGenerationAdvancements(options: {
  generations: readonly number[];
  orderedTasks: readonly ExecutionTask[];
}): void {
  const maximumGeneration = options.generations.at(-1)!;
  for (const generation of options.generations) {
    assertGenerationAdvancement({
      generation,
      maximumGeneration,
      orderedTasks: options.orderedTasks,
    });
  }
}

function assertNotVisiting(options: {
  taskId: TaskId;
  visiting: ReadonlySet<TaskId>;
}): void {
  if (options.visiting.has(options.taskId)) {
    throw new Error('Execution plan contains a dependency cycle.');
  }
}

function visitDependency(options: {
  byId: ReadonlyMap<TaskId, ExecutionTask>;
  taskId: TaskId;
  visited: Set<TaskId>;
  visiting: Set<TaskId>;
}): void {
  if (options.visited.has(options.taskId)) return;
  assertNotVisiting(options);
  options.visiting.add(options.taskId);
  const task = options.byId.get(options.taskId)!;
  for (const dependency of new Set(getDependencies(task))) {
    visitDependency({ ...options, taskId: dependency });
  }
  options.visiting.delete(options.taskId);
  options.visited.add(options.taskId);
}

function assertAcyclic(plan: ExecutionPlan): void {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visited = new Set<TaskId>();
  const visiting = new Set<TaskId>();
  for (const task of plan.tasks) {
    visitDependency({ byId, taskId: task.id, visited, visiting });
  }
}

export function validateExecutionPlan(plan: ExecutionPlan): void {
  assertNonEmptyPlan(plan);
  const ids = assertUniqueTaskIds(plan);
  const orderedTasks = [...plan.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const generations = collectGenerations({ byId, ids, orderedTasks });
  assertContinuousGenerations(generations);
  assertGenerationAdvancements({ generations, orderedTasks });
  assertAcyclic(plan);
}
