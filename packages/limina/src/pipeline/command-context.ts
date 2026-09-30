import type { ResolvedLiminaConfig } from '#config/runner';
import { shouldUseShellForCommand } from '#utils/process';
import type { SpawnOptions } from 'node:child_process';
import path from 'pathe';
import type { TaskProgressItem } from '../execution/progress';
import type { LiminaFlowTask } from '../flow';
import { createTaskFailureIssue } from '../source-check/snapshot';
import {
  type CommandPipelineStep,
  createCommandStepEnvironment,
} from './command-cache';
import { createCommandTaskStats } from './stats';
import type { BuiltinTaskResult, RunPipelineOptions } from './types';

export interface CommandExecutionContext {
  commandItem: TaskProgressItem | undefined;
  commandOptions: SpawnOptions;
  config: ResolvedLiminaConfig;
  cwd: string;
  label: string;
  options: RunPipelineOptions;
  startedAt: number;
  step: CommandPipelineStep;
  task: LiminaFlowTask | undefined;
}

function getStepArguments(step: CommandPipelineStep): readonly string[] {
  return step.args ?? [];
}

function getCommandCwd(options: {
  config: ResolvedLiminaConfig;
  step: CommandPipelineStep;
}): string {
  return options.step.cwd === undefined
    ? options.config.rootDir
    : path.resolve(options.config.rootDir, options.step.cwd);
}

function startCommandProgress(
  options: RunPipelineOptions,
): TaskProgressItem | undefined {
  return options.progress === undefined
    ? undefined
    : options.progress.startItem('command execution');
}

function startCommandFlow(options: {
  label: string;
  pipelineOptions: RunPipelineOptions;
}): LiminaFlowTask | undefined {
  if (options.pipelineOptions.progress !== undefined) return undefined;
  return options.pipelineOptions.flow?.start(`command: ${options.label}`, {
    depth: 1,
  });
}

export function createCommandExecutionContext(options: {
  config: ResolvedLiminaConfig;
  pipelineOptions: RunPipelineOptions;
  step: CommandPipelineStep;
}): CommandExecutionContext {
  const label = [options.step.command, ...getStepArguments(options.step)].join(
    ' ',
  );
  const cwd = getCommandCwd(options);
  return {
    commandItem: startCommandProgress(options.pipelineOptions),
    commandOptions: {
      cwd,
      env: createCommandStepEnvironment(cwd, options.step),
      shell: shouldUseShellForCommand(options.step.command),
    },
    config: options.config,
    cwd,
    label,
    options: options.pipelineOptions,
    startedAt: performance.now(),
    step: options.step,
    task: startCommandFlow({
      label,
      pipelineOptions: options.pipelineOptions,
    }),
  };
}

export function normalizeProcessError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createFailureIssue(
  context: CommandExecutionContext,
  exitCode: number,
) {
  return createTaskFailureIssue({
    code: 'LIMINA_COMMAND_FAILED',
    evidence: [
      { label: 'command', value: context.step.command },
      { label: 'exit code', value: String(exitCode) },
    ],
    fix: 'Inspect the command output above, then rerun the pipeline.',
    fixSteps: [
      'Inspect the command output above this issue.',
      'Fix the failing task or command configuration.',
      `Rerun the pipeline command that includes "${context.label}".`,
    ],
    reason: `Pipeline command "${context.label}" exited with code ${exitCode}.`,
    rootDir: context.config.rootDir,
    task: 'command',
    title: 'Pipeline command failed',
    tool: context.step.command,
    verifyCommands: [context.step.command],
  });
}

export function createCommandResult(
  context: CommandExecutionContext,
  isPassed: boolean,
  exitCode: number,
): BuiltinTaskResult {
  const durationMs = performance.now() - context.startedAt;
  return {
    issues: isPassed ? [] : [createFailureIssue(context, exitCode)],
    passed: isPassed,
    stats: createCommandTaskStats({ durationMs, passed: isPassed }),
  };
}

function getElapsedTime(context: CommandExecutionContext): number {
  return performance.now() - context.startedAt;
}

function markCommandPassed(context: CommandExecutionContext): void {
  const options = { elapsedTimeMs: getElapsedTime(context) };
  context.commandItem?.pass(undefined, options);
  context.task?.pass();
}

function markCommandFailed(
  context: CommandExecutionContext,
  exitCode: number,
): void {
  const options = { elapsedTimeMs: getElapsedTime(context) };
  context.commandItem?.fail(undefined, options);
  context.task?.fail(
    `command failed: ${context.label} exited with code ${exitCode}`,
  );
}

export function markCommandOutcome(
  context: CommandExecutionContext,
  isPassed: boolean,
  exitCode: number,
): void {
  if (isPassed) markCommandPassed(context);
  else markCommandFailed(context, exitCode);
}

export function markCommandError(
  context: CommandExecutionContext,
  error: Error,
): void {
  context.commandItem?.fail(undefined, { error });
  context.task?.fail(undefined, { error });
}
