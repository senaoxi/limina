import {
  createLiminaCheckFlowReporter,
  createLiminaFlowReporter,
  type LiminaFlowReporter,
} from '../flow';

const CLI_RESERVED_TOP_ROWS = 1;

export interface CliFlowBoundary {
  close(): Promise<void>;
  outro(message: string): void;
}

interface FlowCleanupResult {
  error?: unknown;
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) return;
  if (cleanup === undefined) return;
  Object.defineProperty(primary, 'flowCloseError', {
    configurable: true,
    value: cleanup,
  });
}

function runOutro(flow: CliFlowBoundary, message: string): FlowCleanupResult {
  try {
    flow.outro(message);
    return {};
  } catch (error) {
    return { error };
  }
}

async function runClose(flow: CliFlowBoundary): Promise<FlowCleanupResult> {
  try {
    await flow.close();
    return {};
  } catch (error) {
    return { error };
  }
}

export function createCliFlow(
  options: { check?: boolean } = {},
): LiminaFlowReporter {
  return selectCliFlowReporter(options.check);
}

function selectCliFlowReporter(check: boolean | undefined): LiminaFlowReporter {
  return check === true
    ? createLiminaCheckFlowReporter({
        reservedTopRows: CLI_RESERVED_TOP_ROWS,
      })
    : createLiminaFlowReporter({
        reservedTopRows: CLI_RESERVED_TOP_ROWS,
      });
}

export async function closeCliFlow(
  flow: CliFlowBoundary,
  message: string,
): Promise<void> {
  const outro = runOutro(flow, message);
  const close = await runClose(flow);
  if (outro.error !== undefined) {
    attachCleanupError(outro.error, close.error);
    throw outro.error;
  }
  if (close.error !== undefined) throw close.error;
}

async function executeFlowOperation(
  execute: () => Promise<boolean>,
): Promise<{ error?: unknown; passed: boolean }> {
  try {
    return { passed: await execute() };
  } catch (error) {
    return { error, passed: false };
  }
}

function throwFlowOperationError(
  execution: FlowCleanupResult,
  cleanup: FlowCleanupResult,
): void {
  if (execution.error !== undefined) {
    attachCleanupError(execution.error, cleanup.error);
    throw execution.error;
  }

  if (cleanup.error !== undefined) throw cleanup.error;
}

export async function runCliFlowWithCleanup(
  flow: CliFlowBoundary,
  messages: { failed: string; passed: string },
  execute: () => Promise<boolean>,
): Promise<boolean> {
  const execution = await executeFlowOperation(execute);
  const message = execution.passed ? messages.passed : messages.failed;
  const cleanup = await runCloseBoundary(flow, message);
  throwFlowOperationError(execution, cleanup);
  return execution.passed;
}

async function runCloseBoundary(
  flow: CliFlowBoundary,
  message: string,
): Promise<FlowCleanupResult> {
  try {
    await closeCliFlow(flow, message);
    return {};
  } catch (error) {
    return { error };
  }
}

export function runCheckWithCliFlowCleanup(
  flow: CliFlowBoundary,
  execute: () => Promise<boolean>,
): Promise<boolean> {
  return runCliFlowWithCleanup(
    flow,
    { failed: 'limina check failed', passed: 'limina check passed' },
    execute,
  );
}
