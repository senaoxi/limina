export interface RunPoolOptions<T, R> {
  concurrency: number;
  items: readonly T[];
  onError?: (item: T, error: unknown, index: number) => Promise<R> | R;
  onResult?: (item: T, result: R, index: number) => void;
  onStart?: (item: T, index: number) => void;
  run: (item: T, index: number) => Promise<R> | R;
}

export async function runPool<T, R>(
  options: RunPoolOptions<T, R>,
): Promise<R[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Pool concurrency must be an integer greater than 0.');
  }

  if (options.items.length === 0) {
    return [];
  }

  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= options.items.length) {
        return;
      }

      const item = options.items[index]!;

      options.onStart?.(item, index);

      try {
        const result = await options.run(item, index);

        results[index] = result;
        options.onResult?.(item, result, index);
      } catch (error) {
        if (!options.onError) {
          throw error;
        }

        const result = await options.onError(item, error, index);

        results[index] = result;
        options.onResult?.(item, result, index);
      }
    }
  }

  await Promise.all(
    Array.from({
      length: Math.min(options.concurrency, options.items.length),
    }).map(() => runWorker()),
  );

  return results;
}
