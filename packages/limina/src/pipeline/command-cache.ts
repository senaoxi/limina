import type { PipelineStep } from '#config/runner';
import { prependPathEntry } from '#utils/process';
import path from 'pathe';

export type CommandPipelineStep = Extract<PipelineStep, { type: 'command' }>;

export function createCommandStepEnvironment(
  cwd: string,
  step: CommandPipelineStep,
): NodeJS.ProcessEnv {
  return prependPathEntry(
    { ...process.env, ...step.env },
    path.join(cwd, 'node_modules/.bin'),
  );
}
