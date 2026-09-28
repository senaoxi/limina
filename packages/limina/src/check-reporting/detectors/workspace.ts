import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const WORKSPACE_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/core/workspace/validated/shared.ts#createWorkspaceIssue',
    ],
    task: 'workspace:validate',
    tests: [
      'packages/limina/fixtures/detectors/workspace/region-overlap/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
      'packages/limina/src/__tests__/workspace.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
      'packages/limina/src/pipeline/execution-tasks.ts#createWorkspaceValidationTask',
    ],
    task: 'workspace:validate',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/filesystem-read-eio/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/workspace-validation-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceOutputCycle]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/core/workspace/validated/shared.ts#createWorkspaceIssue',
    ],
    task: 'workspace:validate',
    tests: [
      'packages/limina/fixtures/detectors/workspace/output-cycle-mutual/case.mts',
      'packages/limina/fixtures/detectors/workspace/output-cycle-self/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/workspace-validation.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceOutputRootInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/core/workspace/validated/shared.ts#createWorkspaceIssue',
    ],
    task: 'workspace:validate',
    tests: [
      'packages/limina/fixtures/detectors/workspace/output-root-canonical-alias/case.mts',
      'packages/limina/fixtures/detectors/workspace/output-root-repository/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/workspace-validation.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.workspacePackageIdentityConflict]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/core/workspace/validated/shared.ts#createWorkspaceIssue',
    ],
    task: 'workspace:validate',
    tests: [
      'packages/limina/fixtures/detectors/workspace/package-identity-conflict/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/workspace-validation.spec.ts',
    ],
  },
} satisfies PartialDetectorCoverageRegistry;
