import { LiminaDependencyError } from '../dependency-contract';
import { formatErrorMessage } from '../logger';

export class LiminaOptionalToolMissingError extends LiminaDependencyError {
  readonly toolName: string;

  constructor(options: {
    command: string;
    error: unknown;
    packageName: string;
    reason?: string;
    toolName?: string;
  }) {
    const toolName = options.toolName ?? options.packageName;

    super({
      failureKind: 'missing',
      message: [
        'Missing Limina runtime dependency:',
        `  package: ${options.packageName}`,
        `  command: limina ${options.command}`,
        ...(options.reason ? [`  reason: ${options.reason}`] : []),
        `  fix: install it in the workspace running Limina, for example with \`pnpm add -D ${options.packageName}\`.`,
        `  error: ${formatErrorMessage(options.error)}`,
      ].join('\n'),
      ownership: 'limina-runtime',
      packageName: options.packageName,
      scope: 'limina-install',
    });

    this.name = 'LiminaOptionalToolMissingError';
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
