import type { LiminaCheckRunCheckItemSummary } from '../check-reporting/snapshot';
import {
  startTaskProgressTiming,
  type TaskProgressItem,
  type TaskProgressReporter,
} from './progress';

export interface CreateCheckItemStatsOptions {
  durationMs?: number;
  issues?: number;
  name: string;
  passed?: number;
  total: number;
}

export interface CheckCounter {
  add(amount?: number): void;
  readonly value: number;
}

// Tracks validation units: every time a rule is evaluated against one subject.
// Phases read its running delta to report how much work was performed.
export function createCheckCounter(): CheckCounter {
  let value = 0;

  return {
    add(amount = 1) {
      value += Math.max(0, amount);
    },
    get value() {
      return value;
    },
  };
}

export interface CheckItemAccumulator {
  failActive(error: unknown): never;
  getItems(): LiminaCheckRunCheckItemSummary[];
  observe<T>(name: string, operation: () => Promise<T>): Promise<T>;
  record(name: string): void;
  skip(name: string, message?: string): void;
  start(name: string): void;
}

export interface CheckItemAccumulatorOptions {
  plannedItems?: readonly string[];
  progress?: TaskProgressReporter;
}

interface ActiveCheckItem {
  progressItem?: TaskProgressItem;
}

interface CheckItemAccumulatorState {
  activeItem: ActiveCheckItem | undefined;
  getCheckCount: () => number;
  getIssueCount: () => number;
  items: LiminaCheckRunCheckItemSummary[];
  plannedProgressItems: ReadonlyMap<string, TaskProgressItem | undefined>;
  previousCheckCount: number;
  previousIssueCount: number;
  previousRecordTime: number;
  progress: TaskProgressReporter | undefined;
}

function normalizeOptionalNumber(
  value: number | undefined,
): number | undefined {
  return value === undefined ? undefined : Math.max(0, value);
}

function resolvePassedCount(options: {
  issues: number;
  passed: number | undefined;
  total: number;
}): number {
  if (options.passed !== undefined) {
    return Math.max(0, options.passed);
  }

  return options.issues === 0 ? options.total : 0;
}

function hasPassed(total: number, issues: number, passed: number): boolean {
  return issues === 0 && passed >= total;
}

export function createCheckItemStats(
  options: CreateCheckItemStatsOptions,
): LiminaCheckRunCheckItemSummary {
  const total = Math.max(0, options.total);
  const issues = Math.max(0, options.issues ?? 0);
  const passed = resolvePassedCount({
    issues,
    passed: options.passed,
    total,
  });

  return {
    checksPassed: passed,
    checksTotal: total,
    durationMs: normalizeOptionalNumber(options.durationMs),
    issues,
    itemKind: 'check',
    name: options.name,
    status: hasPassed(total, issues, passed) ? 'passed' : 'failed',
  };
}

export function createSkippedCheckItemStats(options: {
  durationMs?: number;
  name: string;
}): LiminaCheckRunCheckItemSummary {
  return {
    checksPassed: 0,
    checksTotal: 0,
    durationMs: normalizeOptionalNumber(options.durationMs),
    issues: 0,
    itemKind: 'check',
    name: options.name,
    status: 'skipped',
  };
}

function getPlannedNames(
  options: CheckItemAccumulatorOptions,
): readonly string[] {
  return options.plannedItems === undefined ? [] : options.plannedItems;
}

function getPlannedItems(
  options: CheckItemAccumulatorOptions,
  plannedNames: readonly string[],
): readonly TaskProgressItem[] {
  return options.progress === undefined
    ? []
    : options.progress.planItems(plannedNames);
}

function createPlannedProgressItems(
  options: CheckItemAccumulatorOptions,
): ReadonlyMap<string, TaskProgressItem | undefined> {
  const plannedNames = getPlannedNames(options);
  const plannedItems = getPlannedItems(options, plannedNames);

  return new Map(
    plannedNames.map((name, index) => [name, plannedItems[index]]),
  );
}

function startProgressItem(
  state: CheckItemAccumulatorState,
  name: string,
): TaskProgressItem | undefined {
  const plannedItem = state.plannedProgressItems.get(name);

  if (plannedItem !== undefined) {
    plannedItem.start();
    return plannedItem;
  }

  return state.progress?.startItem(name);
}

function captureCurrentCounts(state: CheckItemAccumulatorState): void {
  state.previousIssueCount = state.getIssueCount();
  state.previousCheckCount = state.getCheckCount();
  state.previousRecordTime = performance.now();
}

function startItem(state: CheckItemAccumulatorState, name: string): void {
  state.activeItem = {
    progressItem: startProgressItem(state, name),
  };
  captureCurrentCounts(state);
}

function ensureActiveItem(
  state: CheckItemAccumulatorState,
  name: string,
): ActiveCheckItem {
  if (state.activeItem === undefined) {
    startItem(state, name);
  }

  if (state.activeItem === undefined) {
    throw new Error(`Failed to start check item: ${name}`);
  }

  return state.activeItem;
}

function finishProgressItem(
  activeItem: ActiveCheckItem,
  outcome: 'pass' | 'fail',
  elapsedTimeMs: number | undefined,
): void {
  activeItem.progressItem?.[outcome](undefined, { elapsedTimeMs });
}

function finishItem(state: CheckItemAccumulatorState): void {
  state.activeItem = undefined;
  captureCurrentCounts(state);
}

function failActiveItem(
  state: CheckItemAccumulatorState,
  error: unknown,
): never {
  try {
    const activeItem = state.activeItem;
    if (activeItem !== undefined) {
      const elapsedTimeMs = performance.now() - state.previousRecordTime;
      finishItem(state);
      finishProgressItem(activeItem, 'fail', elapsedTimeMs);
    }
  } catch {
    // Preserve the check failure if the progress reporter also fails.
  }
  throw error;
}

async function observeItem<T>(
  state: CheckItemAccumulatorState,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = startTaskProgressTiming(state.plannedProgressItems.get(name));
  try {
    const result = await operation();
    finish?.('pass');
    return result;
  } catch (error) {
    finish?.('fail');
    throw error;
  }
}

function recordItem(state: CheckItemAccumulatorState, name: string): void {
  const activeItem = ensureActiveItem(state, name);
  const now = performance.now();
  const nextIssueCount = state.getIssueCount();
  const nextCheckCount = state.getCheckCount();
  const item = createCheckItemStats({
    durationMs: now - state.previousRecordTime,
    issues: nextIssueCount - state.previousIssueCount,
    name,
    total: nextCheckCount - state.previousCheckCount,
  });

  state.items.push(item);
  finishItem(state);
  finishProgressItem(
    activeItem,
    item.status === 'passed' ? 'pass' : 'fail',
    item.durationMs,
  );
}

function skipItem(
  state: CheckItemAccumulatorState,
  name: string,
  message: string | undefined,
): void {
  const activeItem = state.activeItem;
  const progressItem =
    activeItem?.progressItem ??
    state.plannedProgressItems.get(name) ??
    state.progress?.planItem(name);
  const item = createSkippedCheckItemStats({
    durationMs:
      activeItem === undefined
        ? undefined
        : performance.now() - state.previousRecordTime,
    name,
  });

  state.items.push(item);
  finishItem(state);
  progressItem?.skip(message);
}

function cloneItems(
  items: readonly LiminaCheckRunCheckItemSummary[],
): LiminaCheckRunCheckItemSummary[] {
  return items.map((item) => ({ ...item }));
}

export function createCheckItemAccumulator(
  getIssueCount: () => number,
  getCheckCount: () => number,
  options: CheckItemAccumulatorOptions = {},
): CheckItemAccumulator {
  const state: CheckItemAccumulatorState = {
    activeItem: undefined,
    getCheckCount,
    getIssueCount,
    items: [],
    plannedProgressItems: createPlannedProgressItems(options),
    previousCheckCount: getCheckCount(),
    previousIssueCount: getIssueCount(),
    previousRecordTime: performance.now(),
    progress: options.progress,
  };

  return {
    failActive: (error) => failActiveItem(state, error),
    getItems: () => cloneItems(state.items),
    observe: (name, operation) => observeItem(state, name, operation),
    record: (name) => recordItem(state, name),
    skip: (name, message) => skipItem(state, name, message),
    start: (name) => startItem(state, name),
  };
}
