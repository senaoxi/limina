import { LIMINA_CHECK_ISSUE_CODES, type LiminaCheckIssueCode } from './codes';
import type { LiminaCheckTaskName } from './snapshot';

export type DetectorCoverageEntry = { readonly task: LiminaCheckTaskName } & (
  | {
      readonly kind: 'external-tool' | 'fixture' | 'integration';
      readonly producers: readonly string[];
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'unit';
      readonly producers: readonly string[];
      readonly reason: string;
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'fault-injection';
      readonly producers: readonly string[];
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'planned';
      readonly producers: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'retired';
      readonly reason: string;
    }
);

export type DetectorCoverageRegistry = Readonly<
  Record<LiminaCheckIssueCode, DetectorCoverageEntry>
>;

export interface DetectorScenarioCoverageEntry {
  readonly fixturePath: string;
  readonly kind: 'fault-boundary' | 'passing-control';
  readonly reason: string;
}

export type DetectorScenarioCoverageRegistry = Readonly<
  Record<string, DetectorScenarioCoverageEntry>
>;

const FALLBACK_CONTRACT_TEST =
  'packages/limina/src/__tests__/issue-code-contracts.spec.ts';
const FAULT_FIXTURE_TEST =
  'packages/limina/integration/tests/detector-fixtures.spec.ts';

export const LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE: DetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/typecheck.ts#createCheckerFailureIssues',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
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
      'packages/limina/src/commands/typecheck.ts#createCheckerFailureIssues',
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
      'packages/limina/src/commands/typecheck.ts#createCheckerFailureIssues',
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
      'packages/limina/src/commands/typecheck.ts#createCheckerFailureIssues',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
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
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
      'packages/limina/src/pipeline/runner.ts#runCommandStep',
    ],
    task: 'command',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/command-throw/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/cleanup-descriptor-failure/case.mts',
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
  [LIMINA_CHECK_ISSUE_CODES.graphAccessDenied]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addDeniedReferenceProblems',
      'packages/limina/src/graph-check/runner.ts#addDeniedDepImportProblem',
      'packages/limina/src/graph-check/runner.ts#addDeniedRefImportProblem',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/access-denied-import-dependency/case.mts',
      'packages/limina/fixtures/detectors/graph/access-denied-reference/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/graph.ts#createGraphCheckErrorIssue',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
    ],
    task: 'graph:check',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/cleanup-secondary-after-task-failure/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/graph-check-throw/case.mts',
      'packages/limina/fixtures/detectors/fault-injection/snapshot-secondary-after-task-failure/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/conditions.ts#collectCustomConditionSubtreeSummary',
      'packages/limina/src/graph-check/conditions.ts#addConditionDomainProblems',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/condition-domain-mismatch/case.mts',
      'packages/limina/fixtures/detectors/graph/condition-domain-reference-mismatch/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/dts-options.ts#addDtsOptionProblems',
      'packages/limina/src/graph-check/dts-options.ts#addTypecheckParityProblems',
      'packages/limina/src/graph-check/conditions.ts#addConditionDomainShapeProblem',
      'packages/limina/src/graph-check/conditions.ts#addConditionDomainEntryProblem',
      'packages/limina/src/graph-check/rules.ts#getRulesRecord',
      'packages/limina/src/graph-check/rules.ts#addRuleEntryConfigFinding',
      'packages/limina/src/graph-check/runner.ts#createGraphCheckManagedOutputProjectContexts',
      'packages/limina/src/graph-check/runner.ts#runGraphCheckImpl',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/config-invalid-condition-domain/case.mts',
      'packages/limina/fixtures/detectors/graph/config-invalid-condition-domain-entry/case.mts',
      'packages/limina/fixtures/detectors/graph/config-invalid-rule/case.mts',
      'packages/limina/fixtures/detectors/graph/config-invalid-workspace-export/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addUnmappedWorkspaceImportProblem',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/import-target-unmapped/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
    ],
    task: 'graph:materialize',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/graph-materialize-throw/case.mts',
      FAULT_FIXTURE_TEST,
      'packages/limina/src/__tests__/execution.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/core/build-graph/runner.ts#createGraphPrepareIssue',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
    ],
    task: 'graph:prepare',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/graph-prepare-throw/case.mts',
      FAULT_FIXTURE_TEST,
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addGeneratedReferenceCycleProblems',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/reference-cycle-mutual/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra]: {
    kind: 'unit',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addReferenceCompletenessProblems',
    ],
    reason:
      'Generated same-checker references are normalized before the public CLI check; the graph runner test injects the validated graph boundary and executes the real producer.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing]: {
    kind: 'unit',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addReferenceCompletenessProblems',
    ],
    reason:
      'Normal preparation records a provider edge that satisfies this check; the graph runner test removes that edge at the trusted generated-graph seam and executes the real producer.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable]: {
    kind: 'unit',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addExpectedReferenceForTarget',
    ],
    reason:
      'The state requires a generated target absent from checker reachability, so a graph runner test supplies that inconsistent generated-graph boundary directly.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared]: {
    kind: 'unit',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addWorkspaceReferenceDependencyProblems',
    ],
    reason:
      'Public preparation derives cross-package references from imports; the graph runner test supplies an isolated validated reference edge and executes the real dependency producer.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addBuildArtifactImportProblem',
      'packages/limina/src/graph-check/runner.ts#addOutsideWorkspaceGraphProblem',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/workspace-import-outside-graph/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addWorkspacePackageExportWithoutTypeEntryProblem',
      'packages/limina/src/graph-check/runner.ts#addUnresolvedWorkspaceImportProblem',
      'packages/limina/src/graph-check/runner.ts#addOxcOnlyDeclarationProviderProblem',
    ],
    task: 'graph:check',
    tests: [
      'packages/limina/fixtures/detectors/graph/workspace-import-missing-type-entry/case.mts',
      'packages/limina/fixtures/detectors/graph/workspace-import-unresolved/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/graph-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing]: {
    kind: 'unit',
    producers: [
      'packages/limina/src/graph-check/runner.ts#addNamelessWorkspaceReferenceProblem',
    ],
    reason:
      'Public preparation cannot stably retain a cross-package reference whose package identity is missing; the graph runner test injects that validated boundary and executes the real producer.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.packageAttw]: {
    kind: 'external-tool',
    producers: ['packages/limina/src/package-check/runner.ts#runAttwCheck'],
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
    producers: ['packages/limina/src/package-check/runner.ts#runBoundaryCheck'],
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
      'packages/limina/src/commands/package.ts#createPackageCheckErrorIssues',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
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
      'packages/limina/src/package-check/runner.ts#runPackageCheckEntry',
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
    producers: ['packages/limina/src/package-check/runner.ts#runPublintCheck'],
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
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
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
  [LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/release.ts#createReleaseCheckErrorIssues',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
    ],
    task: 'release:check',
    tests: [
      FALLBACK_CONTRACT_TEST,
      'packages/limina/fixtures/detectors/fault-injection/release-check-throw/case.mts',
      FAULT_FIXTURE_TEST,
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseConsistency]: {
    kind: 'planned',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#releaseConsistency',
    ],
    reason:
      'Registered planned compatibility code; current typed Release producers intentionally do not emit it.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/package-check/release-consistency.ts#addContentHashFinding',
      'packages/limina/src/package-check/release-consistency.ts#verifyWorkspacePackagePublished',
    ],
    task: 'release:check',
    tests: [
      'packages/limina/fixtures/detectors/release/content-hash-changed/case.mts',
      'packages/limina/fixtures/detectors/release/content-hash-config-invalid-baseline-tag/case.mts',
      'packages/limina/fixtures/detectors/release/content-hash-config-invalid-ignore/case.mts',
      'packages/limina/fixtures/detectors/release/content-hash-local-only/case.mts',
      'packages/limina/fixtures/detectors/release/content-hash-remote-only/case.mts',
      'packages/limina/fixtures/detectors/release/content-hash-user-ignore-non-match/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/release-findings.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/commands/release.ts#collectOutputManifestFindings',
      'packages/limina/src/package-check/release-consistency.ts#addPackedManifestFinding',
      'packages/limina/src/package-check/release-consistency.ts#visitWorkspacePackageDependencies',
      'packages/limina/src/package-check/release-consistency.ts#validatePackedManifestLint',
      'packages/limina/src/package-check/release-consistency.ts#validatePackedManifest',
    ],
    task: 'release:check',
    tests: [
      'packages/limina/fixtures/detectors/release/packed-dependency-missing/case.mts',
      'packages/limina/fixtures/detectors/release/packed-dependency-range-mismatch/case.mts',
      'packages/limina/fixtures/detectors/release/packed-manifest-lint/case.mts',
      'packages/limina/fixtures/detectors/release/packed-output-catalog-specifier/case.mts',
      'packages/limina/fixtures/detectors/release/packed-output-file-specifier/case.mts',
      'packages/limina/fixtures/detectors/release/packed-output-link-specifier/case.mts',
      'packages/limina/fixtures/detectors/release/packed-output-workspace-specifier/case.mts',
      'packages/limina/fixtures/detectors/release/packed-source-link-dependency/case.mts',
      'packages/limina/fixtures/detectors/release/packed-source-private-dependency/case.mts',
      'packages/limina/fixtures/detectors/release/packed-source-workspace-dependency-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/release-findings.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: {
    kind: 'external-tool',
    producers: [
      'packages/limina/src/package-check/release-consistency.ts#addRegistryFinding',
      'packages/limina/src/package-check/release-consistency.ts#fetchRegistryPackageMetadata',
      'packages/limina/src/package-check/release-consistency.ts#fetchRegistryTarball',
      'packages/limina/src/package-check/release-consistency.ts#verifyWorkspacePackagePublished',
    ],
    task: 'release:check',
    tests: [
      'packages/limina/fixtures/detectors/release/registry-comparison-failed/case.mts',
      'packages/limina/fixtures/detectors/release/registry-dist-tag-missing/case.mts',
      'packages/limina/fixtures/detectors/release/registry-integrity-invalid/case.mts',
      'packages/limina/fixtures/detectors/release/registry-integrity-mismatch/case.mts',
      'packages/limina/fixtures/detectors/release/registry-integrity-missing/case.mts',
      'packages/limina/fixtures/detectors/release/registry-integrity-priority/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-body-read/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-http-status/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-invalid-json/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-invalid-object/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-request/case.mts',
      'packages/limina/fixtures/detectors/release/registry-metadata-timeout/case.mts',
      'packages/limina/fixtures/detectors/release/registry-package-not-found/case.mts',
      'packages/limina/fixtures/detectors/release/registry-shasum-invalid/case.mts',
      'packages/limina/fixtures/detectors/release/registry-shasum-mismatch/case.mts',
      'packages/limina/fixtures/detectors/release/registry-tarball-body-read/case.mts',
      'packages/limina/fixtures/detectors/release/registry-tarball-http-status/case.mts',
      'packages/limina/fixtures/detectors/release/registry-tarball-request/case.mts',
      'packages/limina/fixtures/detectors/release/registry-tarball-timeout/case.mts',
      'packages/limina/fixtures/detectors/release/registry-tarball-url-missing/case.mts',
      'packages/limina/fixtures/detectors/release/registry-version-missing/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/release-findings.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/commands/release.ts#runReleaseCheckEntry',
      'packages/limina/src/package-check/release-consistency.ts#addTarballHygieneFinding',
      'packages/limina/src/package-check/release-consistency.ts#readPackedPackageJson',
      'packages/limina/src/package-check/release-consistency.ts#validateReleaseTarballHygiene',
    ],
    task: 'release:check',
    tests: [
      'packages/limina/fixtures/detectors/release/tarball-license-missing/case.mts',
      'packages/limina/fixtures/detectors/release/tarball-output-private/case.mts',
      'packages/limina/fixtures/detectors/release/tarball-readme-missing/case.mts',
      'packages/limina/fixtures/detectors/release/tarball-source-map/case.mts',
      'packages/limina/fixtures/detectors/release/tarball-source-mapping-url/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/release-findings.spec.ts',
      'packages/limina/src/__tests__/package.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed]: {
    kind: 'fault-injection',
    producers: [
      'packages/limina/src/check-reporting/codes.ts#DEFAULT_ISSUE_CODE_BY_TASK',
      'packages/limina/src/commands/source.ts#runSourceCheck',
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
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
      'packages/limina/src/source-check/ambient-declarations.ts#createConfigIssue',
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
      'packages/limina/src/source-check/runner.ts#addTsconfigGovernanceProblems',
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
      'packages/limina/src/source-check/runner.ts#addRelativeImportProblems',
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
      'packages/limina/src/source-check/runner.ts#addSourceCrossGovernanceBoundaryProblem',
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
      'packages/limina/src/source-check/runner.ts#addImportAuthorityConfigFinding',
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
      'packages/limina/src/source-check/runner.ts#addKnipBackedSourceProblems',
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
      'packages/limina/src/source-check/runner.ts#addProjectOwnerProblems',
      'packages/limina/src/source-check/runner.ts#addSourceImportOutsideActivatedRegionProblem',
      'packages/limina/src/source-check/runner.ts#addTsconfigGovernanceProblems',
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
      'packages/limina/src/source-check/runner.ts#addPackageImportProblem',
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
      'packages/limina/src/source-check/runner.ts#addPackageImportAuthorizationProblem',
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
      'packages/limina/src/source-check/runner.ts#addRelativeImportOwnerProblem',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/relative-import-escapes-scope/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
      'packages/limina/src/__tests__/source.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/source-check/runner.ts#addTsconfigGovernanceProblems',
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
      'packages/limina/src/source-check/runner.ts#addUnusedModuleProblems',
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
      'packages/limina/src/source-check/runner.ts#addUnusedDependencyProblems',
    ],
    task: 'source:check',
    tests: [
      'packages/limina/fixtures/detectors/source/unused-workspace-dependency/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/source-findings.spec.ts',
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/core/workspace/validated-context.ts#createWorkspaceIssue',
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
      'packages/limina/src/execution/executor.ts#createInfrastructureIssue',
      'packages/limina/src/pipeline/runner.ts#createWorkspaceValidationTask',
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
      'packages/limina/src/core/workspace/validated-context.ts#createWorkspaceIssue',
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
      'packages/limina/src/core/workspace/validated-context.ts#createWorkspaceIssue',
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
      'packages/limina/src/core/workspace/validated-context.ts#createWorkspaceIssue',
    ],
    task: 'workspace:validate',
    tests: [
      'packages/limina/fixtures/detectors/workspace/package-identity-conflict/case.mts',
      'packages/limina/integration/tests/detector-fixtures.spec.ts',
      'packages/limina/src/__tests__/workspace-validation.spec.ts',
    ],
  },
} satisfies DetectorCoverageRegistry;

export const LIMINA_DETECTOR_SCENARIO_COVERAGE: DetectorScenarioCoverageRegistry =
  {
    'checker/build-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/checker/build-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms a real TypeScript checker build produces no issue.',
    },
    'fault-injection/cleanup-descriptor-execution': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/cleanup-descriptor-execution/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains cleanup descriptor accounting after finalization.',
    },
    'fault-injection/cleanup-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/cleanup-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains a cleanup failure that does not emit a canonical issue.',
    },
    'fault-injection/filesystem-close-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-close-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains close failure propagation and cleanup state.',
    },
    'fault-injection/filesystem-fsync-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-fsync-eio/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains fsync failure propagation without fabricated issue output.',
    },
    'fault-injection/filesystem-rename-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-rename-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains atomic rename failure and temporary-file cleanup.',
    },
    'fault-injection/filesystem-write-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-write-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains snapshot write failure and temporary-file cleanup.',
    },
    'fault-injection/finalization-secondary-after-task-failure': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/finalization-secondary-after-task-failure/case.mts',
      kind: 'fault-boundary',
      reason: 'Preserves a primary task failure when finalization also fails.',
    },
    'fault-injection/finalization-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/finalization-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains finalization failure after otherwise successful work.',
    },
    'fault-injection/process-invalid-protocol': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/process-invalid-protocol/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains invalid child protocol handling without issue synthesis.',
    },
    'fault-injection/snapshot-install-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-install-success/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains snapshot installation failure and cleanup state.',
    },
    'fault-injection/snapshot-serialize-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-serialize-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains snapshot serialization failure without issue synthesis.',
    },
    'fault-injection/snapshot-write-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-write-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains snapshot write failure after successful task execution.',
    },
    'package/attw-dual-package-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/package/attw-dual-package-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms ATTW emits no issue for a valid dual package.',
    },
    'proof/coverage-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/proof/coverage-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms valid proof coverage emits no issue.',
    },
    'release/content-hash-builtin-ignore': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/content-hash-builtin-ignore/case.mts',
      kind: 'passing-control',
      reason: 'Confirms built-in ignored content differences emit no issue.',
    },
    'release/content-hash-user-ignore': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/content-hash-user-ignore/case.mts',
      kind: 'passing-control',
      reason: 'Confirms configured ignored content differences emit no issue.',
    },
    'release/tarball-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/tarball-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms a valid release tarball emits no issue.',
    },
    'source/knip-usage-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/source/knip-usage-valid/case.mts',
      kind: 'passing-control',
      reason:
        'Confirms used modules and workspace dependencies emit no Knip issue.',
    },
  };
