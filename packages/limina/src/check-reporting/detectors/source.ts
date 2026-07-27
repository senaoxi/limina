import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const SOURCE_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/source.ts#runSourceCheck',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
    ],
    task: 'source:check',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/source-check-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/ambient-declaration-rules.ts#createAmbientConfigIssue',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/ambient-config-no-matches/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/ambient-declarations.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/tsconfig-governance.ts#addTsconfigGovernanceProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/ambient-shared-unauthorized/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/relative-import-validation.ts#addRelativeImportProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/ambient-reference-unauthorized/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/import-boundary-findings.ts#addSourceCrossGovernanceBoundaryProblem',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/cross-governance-require-resolve/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/import-authority-config-findings.ts#addImportAuthorityConfigFinding',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/import-authority-unknown-owner/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/knip/source-validation.ts#addKnipBackedSourceProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/knip-build-script-unsupported/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/findings.ts#createSourceKnipConfigFinding',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/knip-config-workspaces-invalid/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/project-owner-findings.ts#addProjectOwnerProblems',
      'packages/limina/src/source-check/import-boundary-findings.ts#addSourceImportOutsideActivatedRegionProblem',
      'packages/limina/src/source-check/tsconfig-governance.ts#addTsconfigGovernanceProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/owner-conflict/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/package-import-validator.ts#addPackageImportProblem',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/package-import-invalid/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/import-authorization-finding.ts#addPackageImportAuthorizationProblem',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/package-import-unauthorized/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/import-boundary-findings.ts#addRelativeImportOwnerProblem',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/relative-import-escapes-scope/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound]: {
    kind: 'integration',
    producers: [
      'packages/limina/src/source-check/resource-module-findings.ts#addResourceModuleProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared]: {
    kind: 'integration',
    producers: [
      'packages/limina/src/source-check/resource-module-findings.ts#addResourceModuleProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/tsconfig-governance.ts#addTsconfigGovernanceProblems',
      'packages/limina/src/source-check/runner.ts#runSourceCheckImpl',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/owner-conflict/case.mts',
      'packages/limina/fixtures/detectors/source/tsconfig-module-owner-unresolved/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule]: {
    kind: 'external-tool',
    producers: [
      'packages/limina/src/source-check/knip/unused/findings.ts#addUnusedModuleProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/unused-module/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency]: {
    kind: 'external-tool',
    producers: [
      'packages/limina/src/source-check/knip/unused/findings.ts#addUnusedDependencyProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/unused-workspace-dependency/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
    ],
  },
} satisfies PartialDetectorCoverageRegistry;
