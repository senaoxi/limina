import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { CommandExecutionContext } from './command-context';
import {
  createCommandResult,
  markCommandError,
  markCommandOutcome,
  normalizeProcessError,
} from './command-context';
import type { BuiltinTaskResult } from './types';

interface InteractiveCommandState {
  boundaryError: Error | undefined;
  child: ChildProcess;
  context: CommandExecutionContext;
  settled: boolean;
  timeout: NodeJS.Timeout | undefined;
}

function getCommandArguments(
  context: CommandExecutionContext,
): readonly string[] {
  return context.step.args ?? [];
}

function getInteractiveSpawnOptions(
  context: CommandExecutionContext,
): SpawnOptions {
  return {
    ...context.commandOptions,
    stdio: ['inherit', 'pipe', 'pipe'],
  };
}

function spawnDefaultInteractiveChild(
  context: CommandExecutionContext,
): ChildProcess {
  return spawn(context.step.command, [...getCommandArguments(context)], {
    ...context.commandOptions,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
}

function spawnInteractiveChild(context: CommandExecutionContext): ChildProcess {
  const configuredSpawn = context.options.commandProcess?.spawn;
  return configuredSpawn === undefined
    ? spawnDefaultInteractiveChild(context)
    : configuredSpawn(
        context.step.command,
        getCommandArguments(context),
        getInteractiveSpawnOptions(context),
      );
}

function clearCommandTimeout(state: InteractiveCommandState): void {
  if (state.timeout !== undefined) clearTimeout(state.timeout);
}

function settle(state: InteractiveCommandState, callback: () => void): void {
  if (state.settled) return;
  state.settled = true;
  clearCommandTimeout(state);
  callback();
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function storeBoundaryError(
  state: InteractiveCommandState,
  error: Error,
): void {
  if (state.boundaryError === undefined) state.boundaryError = error;
}

function stopAfterBoundaryError(
  state: InteractiveCommandState,
  error: Error,
): void {
  if (state.settled) return;
  storeBoundaryError(state, error);
  if (isRunning(state.child)) state.child.kill();
}

function attachOutputForwarding(state: InteractiveCommandState): void {
  state.child.stdout?.on('data', (chunk: Uint8Array) => {
    state.context.options.flow?.writeOutput(chunk, { stream: 'stdout' });
  });
  state.child.stderr?.on('data', (chunk: Uint8Array) => {
    state.context.options.flow?.writeOutput(chunk, { stream: 'stderr' });
  });
}

function attachOutputErrors(state: InteractiveCommandState): void {
  state.child.stdout?.on('error', (error) => {
    stopAfterBoundaryError(state, normalizeProcessError(error));
  });
  state.child.stderr?.on('error', (error) => {
    stopAfterBoundaryError(state, normalizeProcessError(error));
  });
}

function rejectBoundaryError(options: {
  error: Error;
  reject: (reason?: unknown) => void;
  state: InteractiveCommandState;
}): void {
  markCommandError(options.state.context, options.error);
  settle(options.state, () => options.reject(options.error));
}

function handleChildError(options: {
  error: unknown;
  reject: (reason?: unknown) => void;
  state: InteractiveCommandState;
}): void {
  if (options.state.settled) return;
  rejectBoundaryError({
    error: normalizeProcessError(options.error),
    reject: options.reject,
    state: options.state,
  });
}

function getExitCode(code: number | null): number {
  return code ?? 1;
}

function handleSuccessfulClose(options: {
  code: number | null;
  resolve: (value: BuiltinTaskResult) => void;
  state: InteractiveCommandState;
}): void {
  const exitCode = getExitCode(options.code);
  const isPassed = exitCode === 0;
  markCommandOutcome(options.state.context, isPassed, exitCode);
  settle(options.state, () =>
    options.resolve(
      createCommandResult(options.state.context, isPassed, exitCode),
    ),
  );
}

function handleChildClose(options: {
  code: number | null;
  reject: (reason?: unknown) => void;
  resolve: (value: BuiltinTaskResult) => void;
  state: InteractiveCommandState;
}): void {
  if (options.state.settled) return;
  const boundaryError = options.state.boundaryError;
  if (boundaryError !== undefined) {
    rejectBoundaryError({
      error: boundaryError,
      reject: options.reject,
      state: options.state,
    });
    return;
  }
  handleSuccessfulClose(options);
}

class CommandTimeoutError extends Error {
  code = 'ETIMEDOUT';
  override name = 'CommandTimeoutError';
}

function createTimeoutError(timeoutMs: number): Error {
  return new CommandTimeoutError(`Command timed out after ${timeoutMs}ms.`);
}

function scheduleTimeout(state: InteractiveCommandState): void {
  const timeoutMs = state.context.options.commandProcess?.timeoutMs;
  if (timeoutMs === undefined) return;
  state.timeout = setTimeout(() => {
    stopAfterBoundaryError(state, createTimeoutError(timeoutMs));
  }, timeoutMs);
}

function attachChildLifecycle(options: {
  reject: (reason?: unknown) => void;
  resolve: (value: BuiltinTaskResult) => void;
  state: InteractiveCommandState;
}): void {
  attachOutputForwarding(options.state);
  attachOutputErrors(options.state);
  options.state.child.on('error', (error) => {
    handleChildError({ ...options, error });
  });
  options.state.child.on('close', (code) => {
    handleChildClose({ ...options, code });
  });
  scheduleTimeout(options.state);
}

function createInteractiveState(
  context: CommandExecutionContext,
): InteractiveCommandState {
  return {
    boundaryError: undefined,
    child: spawnInteractiveChild(context),
    context,
    settled: false,
    timeout: undefined,
  };
}

export function runInteractiveCommand(
  context: CommandExecutionContext,
): Promise<BuiltinTaskResult> {
  return new Promise((resolve, reject) => {
    let state: InteractiveCommandState;
    try {
      state = createInteractiveState(context);
    } catch (error) {
      const normalized = normalizeProcessError(error);
      markCommandError(context, normalized);
      reject(normalized);
      return;
    }
    attachChildLifecycle({ reject, resolve, state });
  });
}
