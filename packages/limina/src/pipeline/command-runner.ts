import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type CommandPipelineStep,
  prepareCommandCacheTargets,
} from './command-cache';
import { createCommandExecutionContext } from './command-context';
import { runInteractiveCommand } from './command-interactive';
import { runSynchronousCommand } from './command-sync';
import type { BuiltinTaskResult, RunPipelineOptions } from './types';

function usesInteractiveFlow(options: RunPipelineOptions): boolean {
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
  await prepareCommandCacheTargets({
    cleanup: options.vueTsgoCacheCleanup,
    cwd: context.cwd,
    step,
  });
  if (usesInteractiveFlow(options)) return runInteractiveCommand(context);
  return runSynchronousCommand(context);
}
