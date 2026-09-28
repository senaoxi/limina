import { LIMINA_CHECK_ISSUE_CODES as C } from '../issue-code-values';
import {
  defineIssueRule,
  type LiminaCheckIssueRuleDefinition,
} from './definition';

export const graphIssueRules: readonly LiminaCheckIssueRuleDefinition[] = [
  defineIssueRule({
    code: C.graphAccessDenied,
    description:
      'A graph rule denied an import, reference, or dependency edge.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphCheckFailed,
    description: 'Graph check failed before a more specific rule was recorded.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphConditionDomainMismatch,
    description: 'Condition domain compiler options do not match their entry.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphConfigInvalid,
    description: 'Graph configuration contains invalid rule or domain entries.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphImportTargetUnmapped,
    description:
      'A governed import target is not mapped into the source graph.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphMaterializeFailed,
    description: 'Generated graph artifacts could not be materialized.',
    task: 'graph:materialize',
  }),
  defineIssueRule({
    code: C.graphPrepareFailed,
    description: 'Generated graph preparation failed.',
    task: 'graph:prepare',
  }),
  defineIssueRule({
    code: C.graphReferenceCycle,
    description: 'Generated TypeScript project references contain a cycle.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphReferenceExtra,
    description:
      'A TypeScript project reference exists without a matching source edge.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphReferenceMissing,
    description: 'A required TypeScript project reference is missing.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphTargetUnreachable,
    description:
      'An expected graph target is not reachable from checker entries.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphWorkspaceDependencyUndeclared,
    description:
      'A cross-package source reference lacks a declared dependency.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphWorkspaceImportOutsideGraph,
    description:
      'A workspace source import resolves outside governed graph coverage.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphWorkspaceImportUnresolved,
    description: 'A workspace source import could not be resolved.',
    task: 'graph:check',
  }),
  defineIssueRule({
    code: C.graphWorkspacePackageNameMissing,
    description:
      'A workspace package in the graph is missing a package identity.',
    task: 'graph:check',
  }),
];
