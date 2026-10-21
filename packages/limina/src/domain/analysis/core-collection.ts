export interface CoreWorkItem {
  readonly id: string;
  readonly configPath: string;
  readonly phase: 'baseline' | 'selection' | 'locked';
  readonly family: string;
  readonly eligibility: 'eligible' | 'unavailable';
  readonly execution: 'not-run' | 'completed' | 'failed';
  readonly reason?: string;
}

export interface CoreCollection {
  readonly dispatch: 'completed' | 'incomplete';
  readonly entries: readonly CoreWorkItem[];
  readonly executionFailureIds: readonly string[];
}

/** Completed means the eligible worklist was drained, not that uncertainty or
 * execution failures disappeared. Missing work cannot vanish with its snapshot. */
export function summarizeCoreCollection(input: {
  closed: boolean;
  entries: readonly CoreWorkItem[];
  executionFailureIds: readonly string[];
}): CoreCollection {
  const isSkipped = input.entries.some(
    (entry) =>
      entry.eligibility === 'eligible' && entry.execution === 'not-run',
  );
  return {
    dispatch: !isSkipped && input.closed ? 'completed' : 'incomplete',
    entries: input.entries,
    executionFailureIds: [...new Set(input.executionFailureIds)],
  };
}
