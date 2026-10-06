import { AsyncLocalStorage } from 'node:async_hooks';

export interface AnalysisRead {
  path: string;
  key: string;
  value: unknown;
  read(): unknown | Promise<unknown>;
}
export type AnalysisReadObserver = (input: AnalysisRead) => void;
const observations = new AsyncLocalStorage<AnalysisReadObserver>();

/**
Scoped to a provider epoch; these callbacks are never persisted.
*/
export function withAnalysisReads<T>(
  observer: AnalysisReadObserver,
  operation: () => T,
): T {
  return observations.run(observer, operation);
}

export function observeAnalysisRead(input: AnalysisRead): void {
  observations.getStore()?.(input);
}

export function readAnalysisInput<T>(
  path: string,
  read: () => T,
  purpose: 'content' | 'file' = 'content',
): T {
  const value = read();
  observeAnalysisRead({
    path,
    key: JSON.stringify([purpose, path]),
    value,
    read,
  });
  return value;
}
