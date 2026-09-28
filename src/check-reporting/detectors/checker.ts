import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const CHECKER_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/checker-failure-issues.ts#createCheckerFailureIssues',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
    ],
    task: 'checker:build',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/checker-build-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerPeerDependencyMissing]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/commands/checker-failure-issues.ts#createCheckerFailureIssues',
    ],
    task: 'checker:build',
    tests: [
      'packages/limina/fixtures/detectors/checker/peer-dependency-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/cli.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/commands/checker-failure-issues.ts#createCheckerFailureIssues',
    ],
    task: 'checker:build',
    tests: [
      'packages/limina/fixtures/detectors/checker/target-selection-preset/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/checker-failure-issues.ts#createCheckerFailureIssues',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
    ],
    task: 'checker:typecheck',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/checker-typecheck-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.commandFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
      'packages/limina/src/pipeline/command-runner.ts#runCommandStep',
    ],
    task: 'command',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/command-throw/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-spawn-enoent/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-nonzero-exit/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-signal-termination/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-timeout/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-stdout-error/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/process-stderr-error/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/timeout-cleanup-secondary/case.mts',
      FAULT_FIXTURE_TEST,
      'packages/limina/src/__tests__/pipeline.spec.ts',
    ],
  },
} satisfies PartialDetectorCoverageRegistry;
