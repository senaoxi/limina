import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
  type CommandExecutionContext,
  createCommandResult,
  markCommandError,
  markCommandOutcome,
  normalizeProcessError,
} from './command-context';
import type { BuiltinTaskResult, CommandProcessDependencies } from './types';

function getSpawnSync(
  context: CommandExecutionContext,
): NonNullable<CommandProcessDependencies['spawnSync']> {
  const configured = context.options.commandProcess?.spawnSync;
  return configured === undefined
    ? (
        command: string,
        arguments_: readonly string[],
        options: SpawnSyncOptions,
      ) => spawnSync(command, [...arguments_], options)
    : configured;
}

function getTimeoutOptions(timeoutMs: number | undefined): {
  timeout?: number;
} {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

function runSyncProcess(
  context: CommandExecutionContext,
): ReturnType<NonNullable<CommandProcessDependencies['spawnSync']>> {
  return getSpawnSync(context)(context.step.command, context.step.args ?? [], {
    ...context.commandOptions,
    stdio: 'inherit',
    ...getTimeoutOptions(context.options.commandProcess?.timeoutMs),
  });
}

function throwProcessError(
  context: CommandExecutionContext,
  error: unknown,
): never {
  const normalized = normalizeProcessError(error);
  markCommandError(context, normalized);
  throw normalized;
}

function getExitCode(
  result: ReturnType<NonNullable<CommandProcessDependencies['spawnSync']>>,
): number {
  return result.status ?? 1;
}

export function runSynchronousCommand(
  context: CommandExecutionContext,
): BuiltinTaskResult {
  let result: ReturnType<NonNullable<CommandProcessDependencies['spawnSync']>>;
  try {
    result = runSyncProcess(context);
  } catch (error) {
    return throwProcessError(context, error);
  }
  if (result.error !== undefined) {
    return throwProcessError(context, result.error);
  }
  const exitCode = getExitCode(result);
  const isPassed = exitCode === 0;
  markCommandOutcome(context, isPassed, exitCode);
  return createCommandResult(context, isPassed, exitCode);
}
