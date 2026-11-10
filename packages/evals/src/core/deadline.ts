import { performance } from 'node:perf_hooks';

export class GradingDeadlineExceeded extends Error {
  constructor() {
    super('Grading phase deadline exceeded');
  }
}

export class GradingDeadline {
  readonly #end: number;
  constructor(milliseconds = 300_000) {
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 1 ||
      milliseconds > 300_000
    )
      throw new Error(
        'Grading budget must be between 1 and 300000 milliseconds',
      );
    this.#end = performance.now() + milliseconds;
  }
  remaining(): number {
    return Math.max(0, Math.floor(this.#end - performance.now()));
  }
  timeout(requested: number): number {
    if (!Number.isSafeInteger(requested) || requested < 1)
      throw new Error('Invalid command timeout');
    const remaining = this.remaining();
    if (remaining === 0) throw new GradingDeadlineExceeded();
    return Math.min(requested, remaining);
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.timeout(300_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new GradingDeadlineExceeded()),
            remaining,
          );
        }),
      ]);
      this.timeout(1);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
