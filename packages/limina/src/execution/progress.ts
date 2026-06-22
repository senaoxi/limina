import type {
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
  LiminaFlowTreeNode,
} from '../flow';

export interface TaskProgressItem {
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
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

function toProgressItem(node: LiminaFlowTreeNode): TaskProgressItem {
  return {
    fail: (message, options) => {
      node.fail(message, options);
    },
    pass: (message, options) => {
      node.pass(message, options);
    },
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
