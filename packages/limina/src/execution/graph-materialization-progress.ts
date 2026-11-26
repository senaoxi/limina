import type { PreparedTsconfigGraph } from '#core/build-graph/runner';
import type {
  MaterializationAccess,
  MaterializationAccessObserver,
} from '../preflight/materialization';
import { startTaskProgressTiming, type TaskProgressReporter } from './progress';

type ProgressOutcome = 'pass' | 'fail';
type FinishProgress = (outcome: ProgressOutcome) => void;

const accessLabels: Record<MaterializationAccess, string> = {
  join: 'wait for',
  reuse: 'reuse',
  start: 'materialize',
};

function observeGraphProgress<T>(report: () => T): T | undefined {
  try {
    return report();
  } catch {
    return undefined;
  }
}

function startGraphProgress(options: {
  access: MaterializationAccess;
  progress: TaskProgressReporter;
  purpose: PreparedTsconfigGraph['purpose'];
  startedAt: number;
}): FinishProgress | undefined {
  const { access, progress, purpose, startedAt } = options;
  const graph = purpose === 'complete' ? 'complete' : 'producer';
  return observeGraphProgress(() => {
    const item = progress.planItem(
      `${accessLabels[access]} ${graph} reference graph`,
    );
    return access === 'reuse'
      ? (outcome: ProgressOutcome) =>
          item[outcome](undefined, { elapsedTimeMs: null })
      : startTaskProgressTiming(item, startedAt);
  });
}

export async function measureGraphMaterialization<T>(options: {
  materialize: (onAccess?: MaterializationAccessObserver) => Promise<T>;
  progress: TaskProgressReporter | undefined;
  purpose: PreparedTsconfigGraph['purpose'];
}): Promise<T> {
  const { materialize, progress, purpose } = options;
  if (progress === undefined) return materialize();

  let finish: FinishProgress | undefined;
  let receipt: T;
  try {
    receipt = await materialize((access, startedAt) => {
      finish = startGraphProgress({ access, progress, purpose, startedAt });
    });
  } catch (error) {
    observeGraphProgress(() => finish?.('fail'));
    throw error;
  }
  observeGraphProgress(() => finish?.('pass'));
  return receipt;
}
