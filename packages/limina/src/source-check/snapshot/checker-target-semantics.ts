import type {
  CheckerTargetCheckItemSnapshot,
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunTaskSummary,
} from './types';
import { firstProblem } from './validation-shared';

interface CheckerTargetIndex {
  indexById: Map<string, number>;
  targetById: Map<string, CheckerTargetCheckItemSnapshot>;
}

function getCheckItems(
  task: LiminaCheckRunTaskSummary,
): readonly LiminaCheckRunCheckItemSummary[] {
  if (task.checkItems === undefined) return [];
  return task.checkItems;
}

function getCheckerTargetItems(
  task: LiminaCheckRunTaskSummary,
): CheckerTargetCheckItemSnapshot[] {
  return getCheckItems(task).filter(
    (item): item is CheckerTargetCheckItemSnapshot =>
      item.itemKind === 'checker-target',
  );
}

function createTargetIndex(options: {
  task: LiminaCheckRunTaskSummary;
  targets: readonly CheckerTargetCheckItemSnapshot[];
}): CheckerTargetIndex | string {
  const targetById = new Map<string, CheckerTargetCheckItemSnapshot>();
  const indexById = new Map<string, number>();
  for (const [index, item] of options.targets.entries()) {
    if (targetById.has(item.id)) {
      return `Task "${options.task.label}" contains duplicate checker target id "${item.id}".`;
    }
    targetById.set(item.id, item);
    indexById.set(item.id, index);
  }
  return { indexById, targetById };
}

function validateBlockerIdentity(options: {
  blocker: { id: string; name: string };
  item: CheckerTargetCheckItemSnapshot;
  seenRoots: Set<string>;
}): string | null {
  if (options.blocker.id === options.item.id) {
    return `Checker target "${options.item.name}" cannot block itself.`;
  }
  if (options.seenRoots.has(options.blocker.id)) {
    return `Checker target "${options.item.name}" contains duplicate blocker "${options.blocker.id}".`;
  }
  options.seenRoots.add(options.blocker.id);
  return null;
}

function getUnknownBlockerProblem(options: {
  blocker: { id: string; name: string };
  item: CheckerTargetCheckItemSnapshot;
  root: CheckerTargetCheckItemSnapshot | undefined;
}): string | null {
  if (options.root !== undefined) return null;
  return `Checker target "${options.item.name}" references unknown blocker "${options.blocker.id}".`;
}

function getBlockerStatusProblem(options: {
  blocker: { id: string; name: string };
  item: CheckerTargetCheckItemSnapshot;
  root: CheckerTargetCheckItemSnapshot | undefined;
}): string | null {
  if (options.root === undefined) return null;
  if (options.root.status === 'failed') return null;
  return `Checker target "${options.item.name}" blocker "${options.root.name}" is not failed.`;
}

function getBlockerLabelProblem(options: {
  blocker: { id: string; name: string };
  root: CheckerTargetCheckItemSnapshot | undefined;
}): string | null {
  if (options.root === undefined) return null;
  if (options.root.name === options.blocker.name) return null;
  return `Checker target blocker label mismatch for "${options.blocker.id}".`;
}

function validateBlockerTarget(options: {
  blocker: { id: string; name: string };
  index: CheckerTargetIndex;
  item: CheckerTargetCheckItemSnapshot;
}): string | null {
  const root = options.index.targetById.get(options.blocker.id);
  return firstProblem([
    getUnknownBlockerProblem({ ...options, root }),
    getBlockerStatusProblem({ ...options, root }),
    getBlockerLabelProblem({ blocker: options.blocker, root }),
  ]);
}

function validateBlockerOrder(options: {
  blockerId: string;
  index: CheckerTargetIndex;
  item: CheckerTargetCheckItemSnapshot;
  previousRootIndex: number;
}): number | string {
  const rootIndex = options.index.indexById.get(options.blockerId);
  if (rootIndex === undefined) {
    return `Checker target "${options.item.name}" references unknown blocker "${options.blockerId}".`;
  }
  if (rootIndex <= options.previousRootIndex) {
    return `Checker target "${options.item.name}" blockers are not in canonical item order.`;
  }
  return rootIndex;
}

function getBlockers(
  item: CheckerTargetCheckItemSnapshot,
): readonly { id: string; name: string }[] {
  if (item.blockedBy === undefined) return [];
  return item.blockedBy;
}

function validateOneBlocker(options: {
  blocker: { id: string; name: string };
  index: CheckerTargetIndex;
  item: CheckerTargetCheckItemSnapshot;
  previousRootIndex: number;
  seenRoots: Set<string>;
}): number | string {
  const problem = firstProblem([
    validateBlockerIdentity(options),
    validateBlockerTarget({
      blocker: options.blocker,
      index: options.index,
      item: options.item,
    }),
  ]);
  if (problem !== null) return problem;
  return validateBlockerOrder({
    blockerId: options.blocker.id,
    index: options.index,
    item: options.item,
    previousRootIndex: options.previousRootIndex,
  });
}

function validateBlockers(options: {
  index: CheckerTargetIndex;
  item: CheckerTargetCheckItemSnapshot;
}): string | null {
  const seenRoots = new Set<string>();
  let previousRootIndex = -1;
  for (const blocker of getBlockers(options.item)) {
    const result = validateOneBlocker({
      blocker,
      index: options.index,
      item: options.item,
      previousRootIndex,
      seenRoots,
    });
    if (typeof result === 'string') return result;
    previousRootIndex = result;
  }
  return null;
}

function validateBlockedTarget(options: {
  index: CheckerTargetIndex;
  item: CheckerTargetCheckItemSnapshot;
}): string | null {
  if (options.item.status !== 'blocked') return null;
  return validateBlockers(options);
}

export function getCheckerTargetRelationProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  const targets = getCheckerTargetItems(task);
  const index = createTargetIndex({ task, targets });
  if (typeof index === 'string') return index;
  return firstProblem(
    targets.map((item) => validateBlockedTarget({ index, item })),
  );
}
