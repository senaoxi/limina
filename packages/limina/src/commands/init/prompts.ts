import * as prompts from '@clack/prompts';
import type { LiminaFlowReporter } from '../../flow';
import type {
  InitFlowStepResult,
  InitFlowStepStatus,
  InitPromptOptions,
} from './types';

interface InitFlowTask {
  fail(reason: string, details: { error: unknown }): void;
  pass(message?: string): void;
  skip(message?: string): void;
}

function assertInteractivePromptAvailable(message: string): void {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return;
  }

  throw new Error(
    `${message} Run limina init --yes to accept the default confirmation in non-interactive environments.`,
  );
}

function assertPromptNotCancelled(
  result: boolean | symbol,
): asserts result is boolean {
  if (!prompts.isCancel(result)) {
    return;
  }

  throw new Error('limina init canceled.');
}

export async function confirmAction(options: {
  message: string;
  prompt: InitPromptOptions;
}): Promise<boolean> {
  if (options.prompt.yes === true) {
    return true;
  }

  assertInteractivePromptAvailable(options.message);
  const result = await prompts.confirm({
    initialValue: true,
    message: options.message,
  });
  assertPromptNotCancelled(result);
  return result;
}

function getOptionalPromptResult(
  result: boolean | symbol,
): 'accepted' | 'rejected' {
  if (prompts.isCancel(result)) {
    return 'rejected';
  }

  return result ? 'accepted' : 'rejected';
}

export async function promptOptionalAction(
  message: string,
): Promise<'accepted' | 'rejected' | 'unavailable'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'unavailable';
  }

  const result = await prompts.confirm({
    initialValue: true,
    message,
  });
  return getOptionalPromptResult(result);
}

function createFlowTask(options: {
  depth: number;
  flow?: LiminaFlowReporter;
  label: string;
}): InitFlowTask | undefined {
  if (options.flow === undefined) {
    return undefined;
  }

  return options.flow.start(options.label, {
    collapseOnSuccess: false,
    depth: options.depth,
  });
}

function completeFlowTask(
  task: InitFlowTask | undefined,
  status: InitFlowStepStatus,
  message: string,
): void {
  if (task === undefined) {
    return;
  }

  if (status === 'skip') {
    task.skip(message);
    return;
  }

  task.pass(message);
}

function failFlowTask(
  task: InitFlowTask | undefined,
  label: string,
  error: unknown,
): void {
  if (task !== undefined) {
    task.fail(`${label} failed`, { error });
  }
}

export async function runInitFlowStep<T>(options: {
  action: () => Promise<InitFlowStepResult<T>>;
  depth: number;
  flow?: LiminaFlowReporter;
  label: string;
}): Promise<T> {
  const task = createFlowTask(options);

  try {
    const result = await options.action();
    completeFlowTask(task, result.status, result.message);
    return result.value;
  } catch (error) {
    failFlowTask(task, options.label, error);
    throw error;
  }
}
