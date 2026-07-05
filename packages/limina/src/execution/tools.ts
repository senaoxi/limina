import { formatErrorMessage } from '../logger';

export class LiminaOptionalToolMissingError extends Error {
  readonly packageName: string;
  readonly toolName: string;

  constructor(options: {
    command: string;
    error: unknown;
    packageName: string;
    reason?: string;
    toolName?: string;
  }) {
    const toolName = options.toolName ?? options.packageName;

    super(
      [
        `Missing peer dependency "${options.packageName}" required by limina ${options.command}.`,
        ...(options.reason ? [`  reason: ${options.reason}`] : []),
        `  fix: install it in the workspace running Limina, for example with \`pnpm add -D ${options.packageName}\`.`,
        `  error: ${formatErrorMessage(options.error)}`,
      ].join('\n'),
    );

    this.name = 'LiminaOptionalToolMissingError';
    this.packageName = options.packageName;
    this.toolName = toolName;
  }
}

export function isLiminaOptionalToolMissingError(
  error: unknown,
): error is LiminaOptionalToolMissingError {
  return error instanceof LiminaOptionalToolMissingError;
}

export function formatMissingOptionalToolSkipMessage(toolName: string): string {
  return `${toolName} is not installed; skipping check`;
}
