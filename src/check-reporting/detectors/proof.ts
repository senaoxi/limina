import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const PROOF_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/allowlist.ts#collectConfiguredAllowlistEntries',
      'packages/limina/src/proof/allowlist.ts#addAllowlistFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/allowlist-file-empty/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#createProofCheckerRouteFinding',
      'packages/limina/src/proof/runner.ts#collectCheckerCoverageTargets',
      'packages/limina/src/proof/runner.ts#addDtsConfigFindings',
      'packages/limina/src/proof/runner.ts#addBuildGraphConfigFindings',
      'packages/limina/src/proof/runner.ts#addSourceReferenceRoleFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/checker-source-references/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/proof.ts#runProofCheck',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
    ],
    task: 'proof:check',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/proof-check-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#addDefaultTsconfigShapeFindings',
      'packages/limina/src/proof/runner.ts#addDefaultTsconfigEnvironmentFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/default-tsconfig-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#addDuplicateGraphCoverageFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/duplicate-graph-json/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#addDuplicateTypecheckOwnershipFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/duplicate-source-owner/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#addSourceBoundaryMismatchFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/source-boundary-mismatch/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/proof/runner.ts#addUncoveredSourceFindings',
    ],
    task: 'proof:check',
    tests: [
      'packages/limina/fixtures/detectors/proof/coverage-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/proof-findings.spec.ts',
      'packages/limina/src/__tests__/proof.spec.ts',
    ],
  },
} satisfies PartialDetectorCoverageRegistry;
