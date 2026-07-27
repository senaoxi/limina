import { defaultTaskFailureCode } from '../check-reporting/codes';
import { writeStandaloneFailureInvocation } from '../check-reporting/invocation-snapshot';
import { createTaskFailureIssue } from '../check-reporting/snapshot';
import {
  createStandaloneInvocationCommand,
  renderGeneratedCommandVariants,
} from '../check-reporting/standalone-invocation-command';
import { formatErrorMessage } from '../logger';
import type { CliFlowBoundary } from './flow';
import { runCliFlowWithCleanup } from './flow';
import type {
  RegisterStandaloneIssueSession,
  StandaloneIssueSession,
} from './types';

interface StandaloneFlowState {
  commandError?: unknown;
  commandPassed: boolean;
  commandSettled: boolean;
  finalizationAttempted: boolean;
  session?: StandaloneIssueSession;
}

function createFallbackIssue(session: StandaloneIssueSession, error: unknown) {
  return createTaskFailureIssue({
    code: defaultTaskFailureCode(session.task),
    filePath: session.config.configPath,
    fix: `Inspect the ${session.title.toLowerCase()} output, then rerun \`${session.command}\`.`,
    reason:
      error === undefined
        ? `${session.title} finished unsuccessfully without structured issue details.`
        : `${session.title} failed: ${formatErrorMessage(error)}.`,
    rootDir: session.config.rootDir,
    task: session.task,
    title: `${session.title} failed`,
  });
}

function formatInvocationQueryLines(
  session: StandaloneIssueSession,
  invocationId: string,
): string[] {
  const command = createStandaloneInvocationCommand(
    session.commandContext,
    invocationId,
  );
  return renderGeneratedCommandVariants(command).map(
    (variant) => `${variant.label}: ${variant.command}`,
  );
}

async function writeStandaloneFailureSession(
  session: StandaloneIssueSession,
  error?: unknown,
): Promise<void> {
  const invocation = await writeStandaloneFailureInvocation({
    artifactNamespace: session.preflight.artifactNamespace,
    command: session.command,
    createFallbackIssue: () => createFallbackIssue(session, error),
    error,
    issues: session.issues,
    rootDir: session.config.rootDir,
  });
  const queryLines = formatInvocationQueryLines(
    session,
    invocation.invocationId,
  );
  process.stdout.write(
    `\nStandalone issue invocation: ${invocation.invocationId}\n${queryLines.join('\n')}\n`,
  );
}

async function finalizeStandaloneFailure(
  state: StandaloneFlowState,
  error?: unknown,
): Promise<void> {
  if (state.session === undefined) return;
  if (state.finalizationAttempted) return;
  state.finalizationAttempted = true;
  await writeStandaloneFailureSession(state.session, error);
}

function registerSession(
  state: StandaloneFlowState,
): RegisterStandaloneIssueSession {
  return (session) => {
    state.session = session;
  };
}

async function executeStandaloneCommand(options: {
  execute: (register: RegisterStandaloneIssueSession) => Promise<boolean>;
  state: StandaloneFlowState;
}): Promise<boolean> {
  try {
    options.state.commandPassed = await options.execute(
      registerSession(options.state),
    );
    options.state.commandSettled = true;
    return options.state.commandPassed;
  } catch (error) {
    options.state.commandError = error;
    throw error;
  }
}

function shouldFinalizeCaughtFailure(state: StandaloneFlowState): boolean {
  if (state.session === undefined) return false;
  if (!state.commandSettled) return true;
  return !state.commandPassed;
}

async function finalizeFailedResult(
  state: StandaloneFlowState,
  passed: boolean,
): Promise<void> {
  if (!passed) await finalizeStandaloneFailure(state);
}

async function finalizeCaughtFailure(
  state: StandaloneFlowState,
): Promise<void> {
  if (!shouldFinalizeCaughtFailure(state)) return;
  await finalizeStandaloneFailure(state, state.commandError);
}

export async function runStandaloneIssueFlow(options: {
  execute: (register: RegisterStandaloneIssueSession) => Promise<boolean>;
  flow: CliFlowBoundary;
  messages: { failed: string; passed: string };
}): Promise<boolean> {
  const state: StandaloneFlowState = {
    commandPassed: false,
    commandSettled: false,
    finalizationAttempted: false,
  };
  try {
    const passed = await runCliFlowWithCleanup(
      options.flow,
      options.messages,
      () => executeStandaloneCommand({ execute: options.execute, state }),
    );
    await finalizeFailedResult(state, passed);
    return passed;
  } catch (error) {
    await finalizeCaughtFailure(state);
    throw error;
  } finally {
    state.session?.preflight.dispose();
  }
}
