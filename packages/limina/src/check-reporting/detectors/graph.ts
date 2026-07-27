import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import { FALLBACK_CONTRACT_TEST, FAULT_FIXTURE_TEST } from './shared';
import type { PartialDetectorCoverageRegistry } from './types';

export const GRAPH_DETECTOR_COVERAGE: PartialDetectorCoverageRegistry = {
  [LIMINA_CHECK_ISSUE_CODES.graphAccessDenied]: {
    kind: 'fixture',
    producers: [
      'packages/limina/src/graph-check/access-denied.ts#addDeniedReferenceProblems',
      'packages/limina/src/graph-check/import-access-denied.ts#addDeniedDepImportProblem',
      'packages/limina/src/graph-check/import-access-denied.ts#addDeniedRefImportProblem',
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
      'packages/limina/src/commands/graph-check-command.ts#createGraphCheckErrorIssue',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
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
      'packages/limina/src/graph-check/condition-subtree.ts#collectCustomConditionSubtreeSummary',
      'packages/limina/src/graph-check/condition-domains.ts#addConditionDomainProblems',
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
      'packages/limina/src/graph-check/dts-declaration-options.ts#addDtsOptionProblems',
      'packages/limina/src/graph-check/dts-typecheck-parity.ts#addTypecheckParityProblems',
      'packages/limina/src/graph-check/condition-domain-config.ts#addConditionDomainShapeProblem',
      'packages/limina/src/graph-check/condition-domain-config.ts#addConditionDomainEntryProblem',
      'packages/limina/src/graph-check/rule-findings.ts#getRulesRecord',
      'packages/limina/src/graph-check/rule-findings.ts#addRuleEntryConfigFinding',
      'packages/limina/src/graph-check/check-context.ts#createGraphCheckManagedOutputProjectContexts',
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
      'packages/limina/src/graph-check/outside-graph-findings.ts#addUnmappedWorkspaceImportProblem',
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
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
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
      'packages/limina/src/core/build-graph/graph-prepare-issues.ts#createGraphPrepareIssue',
      'packages/limina/src/execution/task-execution.ts#createInfrastructureIssue',
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
      'packages/limina/src/graph-check/reference-cycles.ts#addGeneratedReferenceCycleProblems',
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
      'packages/limina/src/graph-check/reference-completeness.ts#addReferenceCompletenessProblems',
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
      'packages/limina/src/graph-check/reference-completeness.ts#addReferenceCompletenessProblems',
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
      'packages/limina/src/graph-check/reference-target.ts#addExpectedReferenceForTarget',
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
      'packages/limina/src/graph-check/workspace-reference-dependencies.ts#addWorkspaceReferenceDependencyProblems',
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
      'packages/limina/src/graph-check/artifact-import-findings.ts#addBuildArtifactImportProblem',
      'packages/limina/src/graph-check/outside-graph-findings.ts#addOutsideWorkspaceGraphProblem',
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
      'packages/limina/src/graph-check/workspace-import-findings.ts#addWorkspacePackageExportWithoutTypeEntryProblem',
      'packages/limina/src/graph-check/unresolved-import-findings.ts#addUnresolvedWorkspaceImportProblem',
      'packages/limina/src/graph-check/unresolved-import-findings.ts#addOxcOnlyDeclarationProviderProblem',
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
      'packages/limina/src/graph-check/workspace-reference-dependencies.ts#addNamelessWorkspaceReferenceProblem',
    ],
    reason:
      'Public preparation cannot stably retain a cross-package reference whose package identity is missing; the graph runner test injects that validated boundary and executes the real producer.',
    task: 'graph:check',
    tests: [
      'packages/limina/src/__tests__/graph-findings.spec.ts',
      'packages/limina/src/__tests__/graph.spec.ts',
    ],
  },
} satisfies PartialDetectorCoverageRegistry;
