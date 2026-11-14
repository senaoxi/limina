import { isIntegerNumber } from '../utils/validation/is-integer';
export interface RunPoolOptions<T, R> {
  concurrency: number;
  items: readonly T[];
  onError?: (item: T, error: unknown, index: number) => Promise<R> | R;
  onResult?: (item: T, result: R, index: number) => void;
  onStart?: (item: T, index: number) => void;
  run: (item: T, index: number) => Promise<R> | R;
}

function assertValidConcurrency(concurrency: number): void {
  if (!isIntegerNumber(concurrency) || concurrency < 1) {
    throw new Error('Pool concurrency must be an integer greater than 0.');
  }
}

export async function runPool<T, R>(
  options: RunPoolOptions<T, R>,
): Promise<R[]> {
  assertValidConcurrency(options.concurrency);

  if (options.items.length === 0) {
    return [];
  }

  const results: R[] = [];
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;

  async function runWorker(): Promise<void> {
    try {
      for (;;) {
        if (failure !== undefined) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= options.items.length) return;

        const item = options.items[index]!;
        options.onStart?.(item, index);
        let result: R;
        try {
          result = await options.run(item, index);
        } catch (error) {
          if (!options.onError) throw error;
          result = await options.onError(item, error, index);
        }
        results[index] = result;
        options.onResult?.(item, result, index);
      }
    } catch (error) {
      failure ??= { error };
    }
  }

  const workerCount = Math.min(options.concurrency, options.items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (failure !== undefined) throw failure.error;
  return results;
}
