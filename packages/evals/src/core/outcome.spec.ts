import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttemptFacts } from './outcome.ts';
import { deriveOutcome } from './outcome.ts';
import type { TaskSpec } from './task.ts';

const task: TaskSpec = {
  version: 2,
  id: 'outcome-contract',
  domain: 'configuration',
  split: 'dev',
  prompt: '',
  fixtureDigest: 'fixture',
  capturePolicy: { excludedRoots: [], requiredRoots: [] },
  mutationPolicy: { rules: [], protectedRoots: [] },
  dependencyPolicy: { inputs: [], variants: [] },
  installPlan: {
    toolchainDigest: 'tools',
    manager: 'pnpm',
    managerVersion: '12.10.1',
    offline: true,
    ignoreScripts: true,
    setupSteps: [],
  },
  gradingContract: {
    graderDigest: 'frozen-grader',
    requiredAssertions: ['coverage', 'behavior'],
  },
};
function success(): AttemptFacts {
  return {
    execution: { status: 'completed', exitCode: 0 },
    captureStatus: 'complete',
    traceStatus: 'complete',
    mutation: {
      status: 'accepted',
      changes: [],
      dependencyVariant: {
        id: 'original',
        inputsDigest: 'inputs',
        closureDigest: 'closure',
      },
    },
    grade: {
      taskId: task.id,
      graderDigest: 'frozen-grader',
      status: 'complete',
      assertions: [
        { id: 'coverage', passed: true },
        { id: 'behavior', passed: true },
      ],
    },
  };
}

test('missing final state does not erase known Agent failures or create a pass', () => {
  assert.equal(deriveOutcome(task, success()).status, 'passed');
  for (const execution of [
    { status: 'completed', exitCode: 1 },
    { status: 'timeout' },
    { status: 'error' },
  ] as const) {
    const outcome = deriveOutcome(task, {
      ...success(),
      execution,
      captureStatus: 'unknown',
      traceStatus: 'unknown',
      mutation: null,
    });
    assert.equal(outcome.isValidAttempt, true);
    assert.equal(
      outcome.status,
      execution.status === 'timeout' ? 'agent_timeout' : 'agent_error',
    );
    assert.equal(outcome.safety, 'unknown');
  }
  const unknown = deriveOutcome(task, {
    ...success(),
    captureStatus: 'partial',
  });
  assert.deepEqual(unknown, {
    status: 'unknown',
    isValidAttempt: false,
    safety: 'unknown',
  });
  assert.equal(
    deriveOutcome(task, { ...success(), traceStatus: 'partial' }).status,
    'unknown',
  );
});

test('green but incomplete, duplicate or stale assertions are grading errors', () => {
  const facts = success();
  assert.ok(facts.grade);
  for (const grade of [
    { ...facts.grade, assertions: [] },
    {
      ...facts.grade,
      assertions: [
        { id: 'coverage', passed: true },
        { id: 'coverage', passed: true },
      ],
    },
    { ...facts.grade, taskId: 'different-task' },
    { ...facts.grade, graderDigest: 'old-grader' },
  ]) {
    assert.deepEqual(deriveOutcome(task, { ...facts, grade }), {
      status: 'grader_error',
      isValidAttempt: false,
      safety: 'safe',
    });
  }
  facts.grade.assertions[1]!.passed = false;
  assert.equal(deriveOutcome(task, facts).status, 'assertion_failed');
});

test('unsafe mutations cannot pass and infrastructure failures need recorded evidence', () => {
  const unsafe = deriveOutcome(task, {
    ...success(),
    mutation: {
      status: 'unsafe',
      violations: [{ path: 'package.json', code: 'dependency_inputs' }],
    },
  });
  assert.deepEqual(unsafe, {
    status: 'unsafe_mutation',
    isValidAttempt: true,
    safety: 'unsafe',
  });
  const facts = {
    ...success(),
    execution: {
      status: 'infra_error' as const,
      evidence: { phase: 'provider' as const, recordId: '' },
    },
  };
  assert.equal(deriveOutcome(task, facts).status, 'unknown');
  facts.execution.evidence.recordId = 'provider-response-429';
  assert.equal(deriveOutcome(task, facts).status, 'infra_error');
  assert.equal(deriveOutcome(task, facts).isValidAttempt, false);
});
