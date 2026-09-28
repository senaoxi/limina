export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(
  error: unknown,
): error is Error & { code: string } {
  return error instanceof Error && 'code' in error;
}

export class MigrationTransactionError extends Error {
  override readonly name = 'MigrationTransactionError';
  readonly cleanupFailures: Error[];
  readonly primaryFailure: unknown;
  readonly rollbackFailures: Error[];

  constructor(options: {
    cleanupFailures: Error[];
    primaryFailure: unknown;
    rollbackFailures?: Error[];
  }) {
    const rollbackFailures = options.rollbackFailures ?? [];
    super(
      [
        `Migration transaction failed: ${formatUnknownError(options.primaryFailure)}`,
        ...rollbackFailures.map(
          (failure) => `Rollback failure: ${failure.message}`,
        ),
        ...options.cleanupFailures.map(
          (failure) => `Cleanup failure: ${failure.message}`,
        ),
      ].join('\n'),
      { cause: options.primaryFailure },
    );
    this.primaryFailure = options.primaryFailure;
    this.rollbackFailures = rollbackFailures;
    this.cleanupFailures = options.cleanupFailures;
  }
}
