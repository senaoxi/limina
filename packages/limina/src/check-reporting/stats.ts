import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaCheckRunCheckItemSummary } from './snapshot';

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
  getItems(): LiminaCheckRunCheckItemSummary[];
  record(name: string): void;
  skip(name: string, message?: string): void;
  start(name: string): void;
}

export interface CheckItemAccumulatorOptions {
  plannedItems?: readonly string[];
  progress?: TaskProgressReporter;
}

export function createCheckItemStats(
  options: CreateCheckItemStatsOptions,
): LiminaCheckRunCheckItemSummary {
  const total = Math.max(0, options.total);
  const issues = Math.max(0, options.issues ?? 0);
  const passed =
    options.passed === undefined
      ? issues === 0
        ? total
        : 0
      : Math.max(0, options.passed);

  return {
    checksPassed: passed,
    checksTotal: total,
    ...(options.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, options.durationMs) }),
    issues,
    name: options.name,
    status: issues === 0 && passed >= total ? 'passed' : 'failed',
  };
}

export function createSkippedCheckItemStats(options: {
  durationMs?: number;
  name: string;
}): LiminaCheckRunCheckItemSummary {
  return {
    checksPassed: 0,
    checksTotal: 0,
    ...(options.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, options.durationMs) }),
    issues: 0,
    name: options.name,
    status: 'skipped',
  };
}

export function createCheckItemAccumulator(
  getIssueCount: () => number,
  getCheckCount: () => number,
  options: CheckItemAccumulatorOptions = {},
): CheckItemAccumulator {
  const items: LiminaCheckRunCheckItemSummary[] = [];
  let activeItem: { name: string; progressItem?: TaskProgressItem } | undefined;
  const plannedNames = options.plannedItems ?? [];
  const plannedItems = options.progress?.planItems(plannedNames) ?? [];
  const plannedProgressItems = new Map(
    plannedNames.map((name, index) => [name, plannedItems[index]]),
  );
  let previousIssueCount = getIssueCount();
  let previousCheckCount = getCheckCount();
  let previousRecordTime = performance.now();

  const startProgressItem = (name: string): TaskProgressItem | undefined => {
    const plannedProgressItem = plannedProgressItems.get(name);

    if (plannedProgressItem) {
      plannedProgressItem.start();
      return plannedProgressItem;
    }

    return options.progress?.startItem(name);
  };
  const startItem = (name: string): void => {
    activeItem = {
      name,
      progressItem: startProgressItem(name),
    };
    previousIssueCount = getIssueCount();
    previousCheckCount = getCheckCount();
    previousRecordTime = performance.now();
  };

  return {
    getItems(): LiminaCheckRunCheckItemSummary[] {
      return items.map((item) => ({ ...item }));
    },
    record(name) {
      if (!activeItem) {
        startItem(name);
      }
      const currentItem = activeItem;

      if (!currentItem) {
        throw new Error(`Failed to start check item: ${name}`);
      }
      const now = performance.now();
      const nextIssueCount = getIssueCount();
      const nextCheckCount = getCheckCount();
      const issues = Math.max(0, nextIssueCount - previousIssueCount);
      const total = Math.max(0, nextCheckCount - previousCheckCount);
      const item = createCheckItemStats({
        durationMs: now - previousRecordTime,
        issues,
        name,
        total,
      });

      items.push(item);
      if (item.status === 'passed') {
        currentItem.progressItem?.pass(undefined, {
          elapsedTimeMs: item.durationMs,
        });
      } else {
        currentItem.progressItem?.fail(undefined, {
          elapsedTimeMs: item.durationMs,
        });
      }
      activeItem = undefined;
      previousIssueCount = nextIssueCount;
      previousCheckCount = nextCheckCount;
      previousRecordTime = now;
    },
    skip(name, message) {
      if (!activeItem) {
        startItem(name);
      }
      const currentItem = activeItem;

      if (!currentItem) {
        throw new Error(`Failed to start check item: ${name}`);
      }
      const now = performance.now();
      const item = createSkippedCheckItemStats({
        durationMs: now - previousRecordTime,
        name,
      });

      items.push(item);
      currentItem.progressItem?.skip(message, {
        elapsedTimeMs: item.durationMs,
      });
      activeItem = undefined;
      previousIssueCount = getIssueCount();
      previousCheckCount = getCheckCount();
      previousRecordTime = now;
    },
    start(name) {
      startItem(name);
    },
  };
}
