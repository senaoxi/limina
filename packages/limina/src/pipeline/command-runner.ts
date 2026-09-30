import type { ResolvedLiminaConfig } from '#config/runner';
import type { CommandPipelineStep } from './command-cache';
import { createCommandExecutionContext } from './command-context';
import { runInteractiveCommand } from './command-interactive';
import { runSynchronousCommand } from './command-sync';
import type { BuiltinTaskResult, RunPipelineOptions } from './types';

function isUsesInteractiveFlow(options: RunPipelineOptions): boolean {
  return options.flow?.interactive === true;
}

export async function runCommandStep(
  config: ResolvedLiminaConfig,
  step: CommandPipelineStep,
  options: RunPipelineOptions = {},
): Promise<BuiltinTaskResult> {
  const context = createCommandExecutionContext({
    config,
    pipelineOptions: options,
    step,
  });
  return isUsesInteractiveFlow(options)
    ? runInteractiveCommand(context)
    : runSynchronousCommand(context);
}
