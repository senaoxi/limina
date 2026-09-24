import type { createElapsedTimer } from 'logaria/helper';
import { InitLogger } from '../../logger';
import type { RunInitResult } from './types';

type InitElapsedLogOptions = ReturnType<ReturnType<typeof createElapsedTimer>>;

function getNextCommand(result: RunInitResult): string {
  if (result.installCommand === undefined)
    return 'install dependencies with your package manager, then run the limina:build package script.';
  return result.installRequired
    ? `${result.installCommand} && ${result.buildCommand}`
    : result.buildCommand;
}

export function reportInitSuccess(
  result: RunInitResult,
  elapsed: InitElapsedLogOptions,
): void {
  InitLogger.success(
    `init generated ${result.writtenFiles.length} files for ${result.workspacePackageCount} workspace packages.`,
    elapsed,
  );
  if (result.installRequired) {
    InitLogger.info(
      result.installCommand === undefined
        ? 'Limina dependencies were added to devDependencies; install them with your package manager before building.'
        : `limina dependencies were added to devDependencies; run ${result.installCommand} before building.`,
    );
  }
  InitLogger.info(`next: ${getNextCommand(result)}`);
  InitLogger.info(
    'migration: run npx limina migration to move tsconfig output settings under Limina governance.',
  );
}
