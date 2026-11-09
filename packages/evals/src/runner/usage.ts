import type { UsageRecord } from '../core/budget.ts';

/**
Parse the pinned CLI event stream without inventing absent measurements.
*/
export function usageFromEvents(events: unknown[]): UsageRecord {
  const completed = events.filter(
    (event): event is { type: string; usage?: Record<string, unknown> } =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'turn.completed',
  );
  const raw = completed.length === 1 ? completed[0]?.usage : undefined;
  const token = (key: string) =>
    typeof raw?.[key] === 'number' &&
    Number.isSafeInteger(raw[key]) &&
    raw[key] >= 0
      ? raw[key]
      : null;
  const inputTokens = token('input_tokens');
  const cachedInputTokens = token('cached_input_tokens');
  const outputTokens = token('output_tokens');
  const isComplete =
    inputTokens !== null &&
    cachedInputTokens !== null &&
    outputTokens !== null &&
    cachedInputTokens <= inputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    credits: null,
    estimatedUsd: null,
    settledUsd: null,
    source: 'codex-exec:turn.completed',
    complete: isComplete,
    settlement: 'unknown',
  };
}
