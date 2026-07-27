import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const PACKAGE_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.packageAttw]: {
    kind: 'external-tool',
    producers: ['packages/limina/src/package-check/attw-check.ts#runAttwCheck'],
    task: 'package:check',
    tests: [
      'packages/limina/fixtures/detectors/package/attw-cjs-only-exports-default/case.mts',
      'packages/limina/fixtures/detectors/package/attw-cjs-resolves-to-esm/case.mts',
      'packages/limina/fixtures/detectors/package/attw-fallback-condition/case.mts',
      'packages/limina/fixtures/detectors/package/attw-false-cjs/case.mts',
      'packages/limina/fixtures/detectors/package/attw-false-esm/case.mts',
      'packages/limina/fixtures/detectors/package/attw-false-export-default/case.mts',
      'packages/limina/fixtures/detectors/package/attw-internal-resolution-error/case.mts',
      'packages/limina/fixtures/detectors/package/attw-missing-export-equals/case.mts',
      'packages/limina/fixtures/detectors/package/attw-named-exports/case.mts',
      'packages/limina/fixtures/detectors/package/attw-no-resolution-bundler/case.mts',
      'packages/limina/fixtures/detectors/package/attw-unexpected-module-syntax/case.mts',
      'packages/limina/fixtures/detectors/package/attw-untyped-resolution-bundler/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.packageBoundary]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/package-check/boundary-check.ts#runBoundaryCheck',
    ],
    task: 'package:check',
    tests: [
      'packages/limina/fixtures/detectors/package/boundary-browser-node-builtin/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-external-package-undeclared/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-invalid-target/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-missing/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-null-target/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-target-escapes-root/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-target-missing/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-imports-target-unsupported/case.mts',
      'packages/limina/fixtures/detectors/package/boundary-self-import-not-exported/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.packageCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/package-command.ts#createPackageCheckErrorIssues',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
    ],
    task: 'package:check',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/package-check-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/package-check/entry/runner.ts#runPackageCheckEntry',
    ],
    task: 'package:check',
    tests: [
      'packages/limina/fixtures/detectors/package/manifest-local-specifier-catalog/case.mts',
      'packages/limina/fixtures/detectors/package/manifest-local-specifier-file/case.mts',
      'packages/limina/fixtures/detectors/package/manifest-local-specifier-link/case.mts',
      'packages/limina/fixtures/detectors/package/manifest-local-specifier-workspace/case.mts',
      'packages/limina/fixtures/detectors/package/manifest-name-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.packagePublint]: {
    kind: 'external-tool',
    producers: [
      'packages/limina/src/package-check/publint-check.ts#runPublintCheck',
    ],
    task: 'package:check',
    tests: [
      'packages/limina/fixtures/detectors/package/publint-export-file-missing/case.mts',
      'packages/limina/fixtures/detectors/package/publint-exports-types-order/case.mts',
      'packages/limina/fixtures/detectors/package/publint-module-should-be-esm/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed]: {
    kind: 'retired',
    reason:
      'Released legacy alias with no independent producer; historical readers accept it, while new issue creators and snapshot writers reject it.',
    task: 'command',
  },
} satisfies PartialDetectorCoverageRegistry;
