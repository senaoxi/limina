import type { RuleOptionProblem } from './contracts';

export class ConfigError extends Error {
  static {
    // Retain the public constructor name while the internal identifier follows lint policy.
    Object.defineProperty(this, 'name', { value: 'ConfigurationError' });
  }

  override readonly name = 'ConfigurationError';
  readonly problems: readonly RuleOptionProblem[];

  constructor(message: string, problems: readonly RuleOptionProblem[] = []) {
    super(message);
    this.problems = problems;
  }
}

export class ExecutionFailure extends Error {
  override readonly name = 'ExecutionFailure';
  override readonly cause: unknown;
  readonly stage?: string;

  constructor(message: string, options: { cause: unknown; stage?: string }) {
    super(message);
    this.cause = options.cause;
    this.stage = options.stage;
  }
}

export class CancelledFailure extends Error {
  override readonly name = 'CancelledFailure';

  constructor(message = 'Analysis was cancelled.') {
    super(message);
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledFailure();
  }
}
