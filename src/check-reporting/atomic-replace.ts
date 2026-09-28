import { rename } from 'node:fs/promises';

const RETRYABLE_REPLACE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800] as const;

export interface ReplaceFileWithRetryOptions {
  beforeAttempt?: (context: {
    attempt: number;
    sourcePath: string;
    targetPath: string;
  }) => Promise<void>;
  replace?: (sourcePath: string, targetPath: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export class ReplacementDriftError extends Error {
  override readonly name = 'ReplacementDriftError';
}

export class RetryableReplacementValidationIoError extends Error {
  override readonly name = 'RetryableReplacementValidationIoError';
  readonly code: 'EACCES' | 'EBUSY' | 'EPERM';

  constructor(
    code: 'EACCES' | 'EBUSY' | 'EPERM',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.code = code;
  }
}

export class TerminalReplacementValidationError extends Error {
  override readonly name = 'TerminalReplacementValidationError';
}

interface ReplaceAttemptContext {
  beforeAttempt: ReplaceFileWithRetryOptions['beforeAttempt'];
  replace: NonNullable<ReplaceFileWithRetryOptions['replace']>;
  retryDelays: readonly number[];
  sourcePath: string;
  targetPath: string;
}

function isRetryableReplaceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    RETRYABLE_REPLACE_CODES.has(String(error.code))
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function shouldRetryValidation(
  error: unknown,
  attempt: number,
  retryDelays: readonly number[],
): boolean {
  return (
    error instanceof RetryableReplacementValidationIoError &&
    attempt < retryDelays.length
  );
}

function shouldRetryReplacement(
  error: unknown,
  attempt: number,
  retryDelays: readonly number[],
): boolean {
  return isRetryableReplaceError(error) && attempt < retryDelays.length;
}

async function waitForValidationRetry(
  error: unknown,
  attempt: number,
  retryDelays: readonly number[],
): Promise<void> {
  if (!shouldRetryValidation(error, attempt, retryDelays)) {
    throw error;
  }

  await delay(retryDelays[attempt]!);
}

async function validateReplaceAttempt(
  context: ReplaceAttemptContext,
  attempt: number,
): Promise<boolean> {
  if (context.beforeAttempt === undefined) {
    return true;
  }

  try {
    await context.beforeAttempt({
      attempt,
      sourcePath: context.sourcePath,
      targetPath: context.targetPath,
    });
    return true;
  } catch (error) {
    await waitForValidationRetry(error, attempt, context.retryDelays);
    return false;
  }
}

async function waitForReplacementRetry(
  error: unknown,
  attempt: number,
  retryDelays: readonly number[],
): Promise<void> {
  if (!shouldRetryReplacement(error, attempt, retryDelays)) {
    throw error;
  }

  await delay(retryDelays[attempt]!);
}

async function runReplaceAttempt(
  context: ReplaceAttemptContext,
  attempt: number,
): Promise<boolean> {
  try {
    await context.replace(context.sourcePath, context.targetPath);
    return true;
  } catch (error) {
    await waitForReplacementRetry(error, attempt, context.retryDelays);
    return false;
  }
}

async function executeReplaceAttempt(
  context: ReplaceAttemptContext,
  attempt: number,
): Promise<void> {
  const isValidated = await validateReplaceAttempt(context, attempt);

  if (!isValidated) {
    await executeReplaceAttempt(context, attempt + 1);
    return;
  }

  const isReplaced = await runReplaceAttempt(context, attempt);

  if (!isReplaced) {
    await executeReplaceAttempt(context, attempt + 1);
  }
}

function resolveReplace(
  options: ReplaceFileWithRetryOptions,
): NonNullable<ReplaceFileWithRetryOptions['replace']> {
  return options.replace === undefined ? rename : options.replace;
}

function resolveRetryDelays(
  options: ReplaceFileWithRetryOptions,
): readonly number[] {
  return options.retryDelaysMs === undefined
    ? REPLACE_RETRY_DELAYS_MS
    : options.retryDelaysMs;
}

function createReplaceAttemptContext(
  sourcePath: string,
  targetPath: string,
  options: ReplaceFileWithRetryOptions,
): ReplaceAttemptContext {
  return {
    beforeAttempt: options.beforeAttempt,
    replace: resolveReplace(options),
    retryDelays: resolveRetryDelays(options),
    sourcePath,
    targetPath,
  };
}

export async function replaceFileWithRetry(
  sourcePath: string,
  targetPath: string,
  options: ReplaceFileWithRetryOptions = {},
): Promise<void> {
  await executeReplaceAttempt(
    createReplaceAttemptContext(sourcePath, targetPath, options),
    0,
  );
}
