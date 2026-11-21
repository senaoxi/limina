import { shouldUseColor } from '#utils/reporting';
import { currentProfile } from '../application/analysis/observability';
import { defaultTaskFailureCode } from '../check-reporting/codes';
import {
  collectFrameworkInferenceIssues,
  formatFrameworkInferenceWarnings,
} from '../check-reporting/framework-inference';
import { writeStandaloneFailureInvocation } from '../check-reporting/invocation-snapshot';
import { createTaskFailureIssue } from '../check-reporting/snapshot';
import {
  createStandaloneInvocationCommand,
  renderGeneratedCommandVariants,
} from '../check-reporting/standalone-invocation-command';
import { runObservedTask } from '../execution/task-observers';
import { formatErrorMessage } from '../logger';
import type { CliFlowBoundary } from './flow';
import { isRunCliFlowWithCleanup } from './flow';
import type {
  RegisterStandaloneIssueSession,
  StandaloneIssueSession,
} from './types';

interface StandaloneFlowState {
  commandError?: unknown;
  commandPassed: boolean;
  commandSettled: boolean;
  finalizationAttempted: boolean;
  profileTaskStartedAt?: number;
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
    issues: [
      ...session.issues,
      ...collectFrameworkInferenceIssues(session.preflight),
    ],
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
  if (state.session === undefined || state.finalizationAttempted) return;
  state.finalizationAttempted = true;
  await writeStandaloneFailureSession(state.session, error);
}

function registerSession(
  state: StandaloneFlowState,
): RegisterStandaloneIssueSession {
  const observer = currentProfile();
  return (session) => {
    state.session = session;
    if (observer !== undefined) state.profileTaskStartedAt = performance.now();
  };
}

async function isExecuteStandaloneCommand(options: {
  execute: (register: RegisterStandaloneIssueSession) => Promise<boolean>;
  state: StandaloneFlowState;
}): Promise<boolean> {
  const observer = currentProfile();
  const taskId = 'standalone-task';
  const register = registerSession(options.state);
  try {
    options.state.commandPassed = await (observer === undefined
      ? options.execute(register)
      : runObservedTask({
          observer,
          operation: 'execution.standalone-action',
          taskId,
          execute: () => options.execute(register),
          isPassed: Boolean,
        }));
    options.state.commandSettled = true;
    return options.state.commandPassed;
  } catch (error) {
    options.state.commandError = error;
    throw error;
  } finally {
    const { profileTaskStartedAt, session } = options.state;
    if (observer !== undefined)
      try {
        const isPassed = options.state.commandPassed;
        observer.task(taskId, {
          name: session?.task,
          runnerUs:
            profileTaskStartedAt === undefined
              ? undefined
              : Math.round((performance.now() - profileTaskStartedAt) * 1000),
          state: isPassed ? 'passed' : 'failed',
        });
      } catch {
        // Profiling does not own the standalone result.
      }
  }
}

function shouldFinalizeCaughtFailure(state: StandaloneFlowState): boolean {
  return (
    state.session !== undefined &&
    (!state.commandSettled || !state.commandPassed)
  );
}

async function finalizeFailedResult(
  state: StandaloneFlowState,
  isPassedValue: boolean,
): Promise<void> {
  if (!isPassedValue) await finalizeStandaloneFailure(state);
}

async function finalizeCaughtFailure(
  state: StandaloneFlowState,
): Promise<void> {
  if (!shouldFinalizeCaughtFailure(state)) return;
  await finalizeStandaloneFailure(state, state.commandError);
}

export async function isRunStandaloneIssueFlow(options: {
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
    const isPassed = await isRunCliFlowWithCleanup(
      options.flow,
      options.messages,
      () => isExecuteStandaloneCommand({ execute: options.execute, state }),
    );
    await finalizeFailedResult(state, isPassed);
    return isPassed;
  } catch (error) {
    await finalizeCaughtFailure(state);
    throw error;
  } finally {
    if (state.session !== undefined) {
      const warnings = formatFrameworkInferenceWarnings(
        collectFrameworkInferenceIssues(state.session.preflight),
        shouldUseColor(),
      );
      if (warnings.length > 0) process.stderr.write(`\n${warnings}\n`);
      state.session.preflight.dispose();
    }
  }
}
