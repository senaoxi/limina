import type {
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
  LiminaFlowTreeNode,
} from '../flow';

export interface TaskProgressItem {
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
  readonly progress?: TaskProgressReporter;
  skip: (message?: string, options?: LiminaFlowMessageOptions) => void;
  start: (message?: string, options?: LiminaFlowMessageOptions) => void;
}

export interface TaskProgressReporter {
  planItem: (
    name: string,
    options?: LiminaFlowMessageOptions,
  ) => TaskProgressItem;
  planItems: (
    names: readonly string[],
    options?: LiminaFlowMessageOptions,
  ) => TaskProgressItem[];
  startItem: (
    name: string,
    options?: LiminaFlowMessageOptions,
  ) => TaskProgressItem;
}

export function startTaskProgressTiming(
  item: TaskProgressItem | undefined,
  startedAt?: number,
): ((status: 'pass' | 'fail') => void) | undefined {
  if (item === undefined) return undefined;

  try {
    item.start();
  } catch {
    // Keep the handle for settlement if the renderer failed during start.
  }
  const beganAt = startedAt ?? performance.now();
  return (status) => {
    const elapsedTimeMs = performance.now() - beganAt;
    try {
      item[status](undefined, { elapsedTimeMs });
    } catch {
      // Progress output does not own the operation outcome.
    }
  };
}

export async function measureTaskProgress<T>(
  progress: TaskProgressReporter | undefined,
  name: string,
  operation: () => T | Promise<T>,
  isPassed?: (result: T) => boolean,
): Promise<T> {
  let item: TaskProgressItem | undefined;
  try {
    item = progress?.planItem(name);
  } catch {
    // Run the operation even if the renderer could not plan its row.
  }
  const finish = startTaskProgressTiming(item);
  try {
    const pending = operation();
    const result = pending instanceof Promise ? await pending : pending;
    finish?.(isPassed?.(result) === false ? 'fail' : 'pass');
    return result;
  } catch (error) {
    finish?.('fail');
    throw error;
  }
}

function toProgressItem(node: LiminaFlowTreeNode): TaskProgressItem {
  return {
    fail: (message, options) => {
      node.fail(message, options);
    },
    pass: (message, options) => {
      node.pass(message, options);
    },
    progress: createTaskProgressReporter(node),
    skip: (message, options) => {
      node.skip(message, options);
    },
    start: (message, options) => {
      node.start(message, options);
    },
  };
}

export function createTaskProgressReporter(
  parent: LiminaFlowTreeNode | undefined,
): TaskProgressReporter | undefined {
  if (!parent) {
    return undefined;
  }

  return {
    planItem: (name, options) => toProgressItem(parent.child(name, options)),
    planItems: (names, options) =>
      parent.children(names, options).map(toProgressItem),
    startItem: (name, options) => {
      const item = toProgressItem(parent.child(name, options));

      item.start(undefined, options);

      return item;
    },
  };
}
