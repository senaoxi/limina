import type {
  CompletedRunOutcome,
  ExecutionTaskIdentity,
  RunLifecycleState,
  TaskId,
  TaskLifecycleEvent,
  TaskLifecycleState,
} from './tasks';

const plannedTransitions: Partial<
  Record<TaskLifecycleEvent['type'], TaskLifecycleState>
> = {
  block: 'blocked',
  skip: 'skipped',
  start: 'running',
};

const runningTransitions: Partial<
  Record<TaskLifecycleEvent['type'], TaskLifecycleState>
> = {
  fail: 'failed',
  pass: 'passed',
};

function getTransitionMap(
  current: TaskLifecycleState,
): Partial<Record<TaskLifecycleEvent['type'], TaskLifecycleState>> {
  if (current === 'planned') {
    return plannedTransitions;
  }

  return current === 'running' ? runningTransitions : {};
}

function nextTaskState(
  current: TaskLifecycleState,
  event: TaskLifecycleEvent,
): TaskLifecycleState | undefined {
  return getTransitionMap(current)[event.type];
}

export function transitionTask(
  current: TaskLifecycleState,
  event: TaskLifecycleEvent,
): TaskLifecycleState {
  const next = nextTaskState(current, event);

  if (!next) {
    throw new Error(
      `Invalid execution task transition: ${current} -> ${event.type}.`,
    );
  }

  return next;
}

export class ExecutionStateStore {
  readonly #states: Map<TaskId, TaskLifecycleState>;
  #runState: RunLifecycleState = 'not-run';

  constructor(tasks: readonly ExecutionTaskIdentity[]) {
    this.#states = new Map(tasks.map((task) => [task.id, 'planned' as const]));

    if (this.#states.size !== tasks.length) {
      throw new Error('Execution plan contains duplicate task ids.');
    }
  }

  get runState(): RunLifecycleState {
    return this.#runState;
  }

  get(taskId: TaskId): TaskLifecycleState {
    const state = this.#states.get(taskId);

    if (!state) {
      throw new Error(`Unknown execution task id: ${taskId}.`);
    }

    return state;
  }

  entries(): ReadonlyMap<TaskId, TaskLifecycleState> {
    return new Map(this.#states);
  }

  transition(taskId: TaskId, event: TaskLifecycleEvent): TaskLifecycleState {
    const next = transitionTask(this.get(taskId), event);

    this.#states.set(taskId, next);
    if (event.type === 'start' && this.#runState === 'not-run') {
      this.#runState = 'running';
    }

    return next;
  }

  finish(outcome: CompletedRunOutcome): void {
    const { state } = outcome;
    if (this.#runState !== 'running') {
      throw new Error(
        `Invalid execution run transition: ${this.#runState} -> ${state}.`,
      );
    }

    if (
      [...this.#states.values()].some(
        (taskState) => taskState === 'planned' || taskState === 'running',
      )
    ) {
      throw new Error('Cannot finish execution with non-terminal tasks.');
    }

    this.#runState = state;
  }
}
