import type { MutationDecision } from './mutation.ts';
import type { Snapshot } from './snapshot.ts';
import type { TaskSpec } from './task.ts';

export type AgentExecution =
  | { status: 'completed'; exitCode: number }
  | { status: 'error' | 'timeout' | 'unknown' | 'cancelled' | 'not_run' }
  | {
      status: 'infra_error';
      evidence: { phase: 'setup' | 'provider' | 'transport'; recordId: string };
    };

export interface AssertionReport {
  taskId: string;
  graderDigest: string;
  status: 'complete' | 'error' | 'not_run';
  assertions: { id: string; passed: boolean }[];
}

export type OutcomeStatus =
  | 'passed'
  | 'assertion_failed'
  | 'unsafe_mutation'
  | 'agent_error'
  | 'agent_timeout'
  | 'infra_error'
  | 'grader_error'
  | 'unknown'
  | 'cancelled'
  | 'not_run';

export interface AttemptOutcome {
  status: OutcomeStatus;
  isValidAttempt: boolean;
  safety: 'safe' | 'unsafe' | 'unknown';
}

export interface AttemptFacts {
  execution: AgentExecution;
  captureStatus: Snapshot['status'];
  traceStatus: 'complete' | 'partial' | 'unknown';
  mutation: MutationDecision | null;
  grade: AssertionReport | null;
}

function gradeStatus(
  task: TaskSpec,
  grade: AssertionReport | null,
): OutcomeStatus {
  if (
    !grade ||
    grade.status !== 'complete' ||
    grade.taskId !== task.id ||
    grade.graderDigest !== task.gradingContract.graderDigest
  )
    return 'grader_error';
  const expected = task.gradingContract.requiredAssertions;
  const ids = new Set(grade.assertions.map((assertion) => assertion.id));
  if (
    expected.length === 0 ||
    new Set(expected).size !== expected.length ||
    ids.size !== grade.assertions.length ||
    ids.size !== expected.length ||
    expected.some((id) => !ids.has(id))
  )
    return 'grader_error';
  return grade.assertions.every(
    (assertion) => typeof assertion.passed === 'boolean' && assertion.passed,
  )
    ? 'passed'
    : 'assertion_failed';
}

/**
Preserve known execution failures even if final state capture also failed.
*/
export function deriveOutcome(
  task: TaskSpec,
  facts: AttemptFacts,
): AttemptOutcome {
  const safety =
    facts.mutation?.status === 'unsafe'
      ? 'unsafe'
      : facts.captureStatus === 'complete' &&
          facts.mutation?.status === 'accepted'
        ? 'safe'
        : 'unknown';
  const result = (
    status: OutcomeStatus,
    isValidAttempt: boolean,
  ): AttemptOutcome => ({ status, isValidAttempt, safety });
  const execution = facts.execution;
  if (execution.status === 'not_run' || execution.status === 'cancelled')
    return result(execution.status, false);
  if (execution.status === 'timeout') return result('agent_timeout', true);
  if (
    execution.status === 'error' ||
    (execution.status === 'completed' && execution.exitCode !== 0)
  )
    return result('agent_error', true);
  if (execution.status === 'infra_error')
    return result(
      execution.evidence.recordId ? 'infra_error' : 'unknown',
      false,
    );
  if (safety === 'unsafe') return result('unsafe_mutation', true);
  if (
    execution.status === 'unknown' ||
    facts.captureStatus !== 'complete' ||
    facts.traceStatus !== 'complete' ||
    facts.mutation?.status !== 'accepted'
  )
    return result('unknown', false);
  const status = gradeStatus(task, facts.grade);
  return result(status, status !== 'grader_error');
}
