import { MigrationLogger } from 'limina/internal/migration';
import type { MigrationRecord } from './declarations';
import type { MigrationPlanningState } from './planning-state';

export class MigrationPlanningError extends Error {
  readonly records: MigrationRecord[];
  constructor(cause: unknown, records: MigrationRecord[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.records = records;
  }
}

export async function planningPhase<T>(
  state: MigrationPlanningState,
  phase: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now();
  let isComplete = false;
  MigrationLogger.info(`migration phase: ${phase}`);
  try {
    const result = await operation();
    isComplete = true;
    return result;
  } finally {
    const elapsedMilliseconds = Math.round(performance.now() - started);
    state.records.push({
      configPath: state.config.configPath,
      kind: 'planning-phase',
      message: `${phase}: ${isComplete ? 'complete' : 'failed'}`,
      details: { phase, complete: isComplete, elapsedMilliseconds },
    });
    MigrationLogger.info(
      `migration phase ${phase}: ${isComplete ? 'complete' : 'failed'} (${elapsedMilliseconds}ms)`,
    );
  }
}
