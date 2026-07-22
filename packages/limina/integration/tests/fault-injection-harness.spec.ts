import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LIMINA_CHECK_ISSUE_CODES } from '../../src/check-reporting/codes';
import type { LiminaCheckRunSummary } from '../../src/check-reporting/snapshot';
import {
  type DetectorFixtureCase,
  validateDetectorFixtureDefinition,
} from '../helpers/detector-fixture-discovery';
import {
  assertExpectedRunState,
  assertLinesInOrder,
} from '../helpers/detector-fixture-runner';
import type {
  DetectorFixtureDefinition,
  FaultInjectionDefinition,
} from '../helpers/detector-fixture-types';
import {
  createInjectedFaultError,
  FaultInjectionController,
  validateFaultInjectionDefinition,
} from '../helpers/fault-injection';
import { runLimina } from '../helpers/run-limina';

const helperPath = fileURLToPath(
  new URL('../helpers/fault-process-helper.mjs', import.meta.url),
);

function throwFault(
  overrides: Partial<FaultInjectionDefinition> = {},
): FaultInjectionDefinition {
  return {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'graph:check',
    ...overrides,
  };
}

function faultFixture(
  overrides: Partial<DetectorFixtureDefinition> = {},
): DetectorFixtureDefinition {
  return {
    command: ['check', 'fault-injection'],
    expected: {
      exitCode: 1,
      issues: [
        {
          code: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
          task: 'graph:check',
        },
      ],
      primaryCode: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
      runOutcome: 'failed',
      snapshot: { complete: true, expected: true },
      taskStates: { 'graph:check': 'failed' },
    },
    fault: throwFault(),
    id: 'fault-injection/self-test',
    kind: 'fault-injection',
    ...overrides,
  };
}

function matcherFixture(runOutcome: 'failed' | 'passed'): DetectorFixtureCase {
  return {
    casePath: '/fixtures/fault-injection/matcher/case.mts',
    definition: faultFixture({
      expected: {
        exitCode: runOutcome === 'passed' ? 0 : 1,
        issues: [],
        runOutcome,
        snapshot: { complete: true, expected: true },
        taskStates: { 'graph:check': runOutcome },
      },
      id: 'fault-injection/matcher',
    }),
    directoryPath: '/fixtures/fault-injection/matcher',
    id: 'fault-injection/matcher',
    repoSourceRoot: '/fixtures/fault-injection/matcher/repo',
  };
}

function runSummary(result: 'failed' | 'passed'): LiminaCheckRunSummary {
  return {
    command: 'limina check fault-injection',
    completedAt: '2026-07-20T00:00:01.000Z',
    createdAt: '2026-07-20T00:00:00.000Z',
    durationMs: 1000,
    pipeline: 'fault-injection',
    result,
    startedAt: '2026-07-20T00:00:00.000Z',
    tasks: [
      {
        completedAt: '2026-07-20T00:00:01.000Z',
        durationMs: 1000,
        generation: 0,
        id: 'task:graph-check',
        issueTask: 'graph:check',
        kind: 'task',
        label: 'graph:check',
        startedAt: '2026-07-20T00:00:00.000Z',
        state: result,
      },
    ],
  };
}

describe('fault-injection declaration and consumption', () => {
  it('accepts only enumerated point/fault/task combinations', () => {
    expect(
      validateFaultInjectionDefinition(throwFault(), 'fault'),
    ).toMatchObject({
      occurrence: 1,
      point: 'task.execute',
      task: 'graph:check',
    });

    expect(() =>
      validateFaultInjectionDefinition(
        { ...throwFault(), module: './arbitrary.mjs' },
        'fault',
      ),
    ).toThrow(/unsupported fields: module/u);
    expect(() =>
      validateFaultInjectionDefinition(
        {
          ...throwFault(),
          fault: {
            ...throwFault().fault,
            callback: () => {},
          },
        },
        'fault',
      ),
    ).toThrow(/unsupported fields: callback/u);
    expect(() =>
      validateFaultInjectionDefinition(
        {
          fault: { kind: 'stream-error', stream: 'stderr' },
          point: 'process.stdout',
          task: 'command',
        },
        'fault',
      ),
    ).toThrow(/does not match process\.stdout/u);
    expect(() =>
      validateFaultInjectionDefinition(
        {
          fault: { kind: 'timeout' },
          occurrence: 0,
          point: 'process.wait',
          task: 'command',
        },
        'fault',
      ),
    ).toThrow(/positive integer/u);
  });

  it('consumes the declared occurrence exactly and rejects an unhit fault', () => {
    const definition = throwFault({ occurrence: 2 });
    const controller = new FaultInjectionController(definition);

    expect(controller.observe('task.execute', 'graph:check')).toBeUndefined();
    expect(controller.observe('task.execute', 'graph:check')).toEqual(
      definition.fault,
    );
    expect(controller.observations()).toEqual([
      {
        consumed: true,
        expectedOccurrence: 2,
        id: 'primary',
        observedOccurrences: 2,
        point: 'task.execute',
        task: 'graph:check',
      },
    ]);
    expect(() => controller.assertConsumed('fault/consumed')).not.toThrow();

    const unhit = new FaultInjectionController(throwFault());
    expect(() => unhit.assertConsumed('fault/unhit')).toThrow(
      /fault\/unhit[\s\S]*expected occurrence=1 observed=0/u,
    );
  });

  it('validates structured cleanup descriptor counters', () => {
    const definition = validateDetectorFixtureDefinition(
      faultFixture({
        expected: {
          ...faultFixture().expected,
          boundary: {
            cleanupDescriptorCount: 1,
            cleanupDirectoryDescriptorCount: 1,
            cleanupFileDescriptorCount: 0,
            cleanupGenerationCount: 1,
            cleanupResourcesRemoved: 1,
          },
        },
      }),
      {
        casePath: '/fixtures/fault-injection/self-test/case.mts',
        expectedId: 'fault-injection/self-test',
      },
    );

    expect(definition.expected.boundary).toEqual({
      cleanupDescriptorCount: 1,
      cleanupDirectoryDescriptorCount: 1,
      cleanupFileDescriptorCount: 0,
      cleanupGenerationCount: 1,
      cleanupResourcesRemoved: 1,
    });
    expect(() =>
      validateDetectorFixtureDefinition(
        faultFixture({
          expected: {
            ...faultFixture().expected,
            boundary: { cleanupDescriptorCount: -1 },
          },
        }),
        {
          casePath: '/fixtures/fault-injection/self-test/case.mts',
          expectedId: 'fault-injection/self-test',
        },
      ),
    ).toThrow(/non-negative integer/u);
  });

  it('rejects two faults that share one observable target', () => {
    expect(() =>
      validateDetectorFixtureDefinition(
        faultFixture({ secondaryFault: throwFault() }),
        {
          casePath: '/fixtures/fault-injection/self-test/case.mts',
          expectedId: 'fault-injection/self-test',
        },
      ),
    ).toThrow(/cannot target task\.execute for graph:check twice/u);
  });

  it('preserves injected error name and infrastructure code', () => {
    const fault = throwFault().fault;
    if (fault.kind !== 'throw') throw new Error('expected throw fault');
    const error = createInjectedFaultError(fault);

    expect(error).toMatchObject({ code: 'EIO', name: 'FaultInjectedError' });
    expect(error.message).toBe('controlled failure');
  });

  it('allows fallback codes and issue-less launcher failures only for fault fixtures', () => {
    expect(
      validateDetectorFixtureDefinition(faultFixture(), {
        casePath: '/fixtures/fault-injection/self-test/case.mts',
        expectedId: 'fault-injection/self-test',
      }).expected.primaryCode,
    ).toBe(LIMINA_CHECK_ISSUE_CODES.graphCheckFailed);

    expect(() =>
      validateDetectorFixtureDefinition(faultFixture({ kind: 'filesystem' }), {
        casePath: '/fixtures/fault-injection/self-test/case.mts',
        expectedId: 'fault-injection/self-test',
      }),
    ).toThrow(/fault is only valid/u);

    const issueLess = faultFixture({
      expected: {
        error: { code: 'EFINAL', expected: true },
        exitCode: 1,
        issues: [],
        runOutcome: 'passed',
        snapshot: { expected: false },
      },
      fault: throwFault({ point: 'execution.finalize' }),
    });
    expect(() =>
      validateDetectorFixtureDefinition(issueLess, {
        casePath: '/fixtures/fault-injection/self-test/case.mts',
        expectedId: 'fault-injection/self-test',
      }),
    ).not.toThrow();
  });
});

describe('fault-injection structured matchers', () => {
  it('matches run outcomes and task states without parsing stdout', () => {
    expect(() =>
      assertExpectedRunState({
        fixture: matcherFixture('failed'),
        run: runSummary('failed'),
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedRunState({
        fixture: matcherFixture('passed'),
        run: runSummary('failed'),
      }),
    ).toThrow(/run outcome mismatch/u);
  });

  it('checks each stream internally and rejects reversed order', () => {
    expect(() =>
      assertLinesInOrder({
        fixtureId: 'fault/stream-order',
        label: 'stdout',
        lines: ['one', 'two'],
        output: 'one\ntwo\n',
      }),
    ).not.toThrow();
    expect(() =>
      assertLinesInOrder({
        fixtureId: 'fault/stream-order',
        label: 'stderr',
        lines: ['two', 'one'],
        output: 'one\ntwo\n',
      }),
    ).toThrow(/in-stream sequence/u);
  });
});

describe('fault helper executable', () => {
  const entry = { args: [helperPath], executable: process.execPath };
  const runHelper = (args: readonly string[], timeout = 2000) =>
    runLimina({
      args,
      cwd: process.cwd(),
      entry,
      fixtureName: `fault-helper-${args[0]}`,
      timeout,
    });

  it('exits with a controlled non-zero code', async () => {
    await expect(runHelper(['exit', '17'])).resolves.toMatchObject({
      code: 17,
      signal: null,
      timedOut: false,
    });
  });

  it('preserves stdout and stderr order independently', async () => {
    const result = await runHelper(['streams-exit', '19']);

    expect(result.code).toBe(19);
    expect(result.stdout.indexOf('stdout-one')).toBeLessThan(
      result.stdout.indexOf('stdout-two'),
    );
    expect(result.stderr.indexOf('stderr-one')).toBeLessThan(
      result.stderr.indexOf('stderr-two'),
    );
  });

  it('terminates itself through the requested signal mode', async () => {
    const result = await runHelper(['signal', 'SIGTERM']);

    if (process.platform === 'win32') {
      expect(result.signal === 'SIGTERM' || result.code !== 0).toBe(true);
    } else {
      expect(result).toMatchObject({ code: null, signal: 'SIGTERM' });
    }
    expect(result.timedOut).toBe(false);
  });

  it('is reliably terminated by the integration watchdog', async () => {
    const result = await runHelper(['timeout'], 1000);

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('helper-waiting');
    expect(result.code !== null || result.signal !== null).toBe(true);
  });

  it('emits a controlled invalid protocol payload', async () => {
    await expect(
      runHelper(['invalid-protocol', '{invalid']),
    ).resolves.toMatchObject({
      code: 0,
      signal: null,
      stdout: '{invalid',
      timedOut: false,
    });
  });
});
