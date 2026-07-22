import type { ResolvedLiminaConfig } from '#config/runner';

import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import {
  type CanonicalLiminaCheckIssue,
  createTaskFailureIssue,
  type LiminaCheckIssueEvidence,
  type LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';

export type GraphSemanticIssueCode =
  | typeof LIMINA_CHECK_ISSUE_CODES.graphAccessDenied
  | typeof LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch
  | typeof LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped
  | typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle
  | typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra
  | typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing
  | typeof LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable
  | typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared
  | typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph
  | typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved
  | typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing;

export const GRAPH_SEMANTIC_ISSUE_CODES: readonly GraphSemanticIssueCode[] = [
  LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
  LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
  LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
  LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
  LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
  LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
  LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
  LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable,
  LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
  LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
  LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
  LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
] satisfies readonly LiminaWritableCheckIssueCode[];

export interface GraphImportFact {
  readonly filePath: string;
  readonly kind: string;
  readonly line: number;
  readonly specifier: string;
}

export interface GraphFindingPresentation {
  readonly detailLines: readonly string[];
  readonly fix?: string;
  readonly reason: string;
  readonly title: string;
}

interface GraphFindingBase<Code extends GraphSemanticIssueCode, Facts> {
  readonly checkerName?: string;
  readonly code: Code;
  readonly evidence: readonly LiminaCheckIssueEvidence[];
  readonly facts: Facts;
  readonly filePath: string;
  readonly locations: readonly LiminaCheckIssueLocation[];
  readonly presentation: GraphFindingPresentation;
  readonly task: 'graph:check';
}

export type GraphAccessDeniedFacts =
  | {
      readonly deniedDependency: string;
      readonly import: GraphImportFact;
      readonly importingProjectPath: string;
      readonly kind: 'import-dependency';
      readonly labels: readonly string[];
      readonly ruleReason: string;
    }
  | {
      readonly deniedReferencePath: string;
      readonly import: GraphImportFact;
      readonly importingProjectPath: string;
      readonly kind: 'import-reference';
      readonly labels: readonly string[];
      readonly ruleReason: string;
      readonly targetProjectPath: string;
    }
  | {
      readonly kind: 'project-reference';
      readonly labels: readonly string[];
      readonly referencedProjectPath: string;
      readonly referencingProjectPath: string;
      readonly ruleKind: 'dependency' | 'reference';
      readonly ruleReason: string;
      readonly ruleValue: string;
    };

export interface GraphAccessDeniedFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    GraphAccessDeniedFacts
  > {
  readonly packageName?: string;
}

export type GraphConditionDomainMismatchFacts =
  | {
      readonly actualConditions: readonly string[];
      readonly expectedConditions: readonly string[];
      readonly kind: 'domain-entry';
      readonly domainName: string;
      readonly entryProjectPath: string;
    }
  | {
      readonly actualConditions: readonly string[];
      readonly expectedConditions: readonly string[];
      readonly kind: 'reference-tree';
      readonly referencedProjectPath: string;
      readonly rootProjectPath: string;
    };

export type GraphConditionDomainMismatchFinding = GraphFindingBase<
  typeof LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
  GraphConditionDomainMismatchFacts
>;

export type GraphConfigInvalidFacts =
  | {
      readonly configPath: string;
      readonly field?: string;
      readonly kind: 'condition-domain';
    }
  | {
      readonly actual: unknown;
      readonly expected: unknown;
      readonly kind: 'declaration-option';
      readonly optionName: string;
      readonly projectPath: string;
    }
  | {
      readonly configPath: string;
      readonly kind: 'graph-rule';
      readonly field?: string;
    }
  | {
      readonly kind: 'output-options';
      readonly projectPath: string;
    }
  | {
      readonly kind: 'project-label';
      readonly projectPath: string;
    }
  | {
      readonly configPath: string;
      readonly kind: 'route';
    }
  | {
      readonly declarationProjectPath: string;
      readonly kind: 'typecheck-parity';
      readonly mismatch: 'files' | 'missing-companion' | 'option';
      readonly optionName?: string;
      readonly typecheckProjectPath: string;
    }
  | {
      readonly configPath: string;
      readonly kind: 'workspace-export';
      readonly packageManifestPath?: string;
      readonly packageName?: string;
    };

export interface GraphConfigInvalidFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    GraphConfigInvalidFacts
  > {
  readonly packageManifestPath?: string;
  readonly packageName?: string;
}

export interface GraphImportTargetUnmappedFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
    {
      readonly import: GraphImportFact;
      readonly importingProjectPath: string;
      readonly resolvedFilePath: string;
      readonly targetPackageName: string;
    }
  > {
  readonly packageName: string;
}

export type GraphReferenceCycleFinding = GraphFindingBase<
  typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
  {
    readonly edges: readonly {
      readonly from: string;
      readonly to: string;
    }[];
    readonly projectPaths: readonly string[];
  }
>;

export type GraphReferenceExtraFinding = GraphFindingBase<
  typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
  {
    readonly extraReferencePath: string;
    readonly projectPath: string;
  }
>;

export type GraphReferenceMissingFinding = GraphFindingBase<
  typeof LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
  {
    readonly expectedReferencePath: string;
    readonly imports: readonly GraphImportFact[];
    readonly projectPath: string;
  }
>;

export type GraphTargetUnreachableFinding = GraphFindingBase<
  typeof LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable,
  {
    readonly import: GraphImportFact;
    readonly importingProjectPath: string;
    readonly targetProjectPath: string;
  }
>;

export interface GraphWorkspaceDependencyUndeclaredFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
    {
      readonly packageManifestPath: string;
      readonly referencedPackageName: string;
      readonly referencedProjectPath: string;
      readonly referencingPackageName: string;
      readonly referencingProjectPath: string;
    }
  > {
  readonly packageManifestPath: string;
  readonly packageName: string;
}

export interface GraphWorkspaceImportOutsideGraphFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
    {
      readonly import: GraphImportFact;
      readonly importingProjectPath: string;
      readonly kind: 'build-artifact' | 'outside-workspace-graph';
      readonly referencedProjectPath?: string;
      readonly resolvedFilePath: string;
      readonly targetPackageName: string;
    }
  > {
  readonly packageName: string;
}

export interface GraphWorkspaceImportUnresolvedFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    {
      readonly import: GraphImportFact;
      readonly importingProjectPath: string;
      readonly kind: 'missing-type-entry' | 'oxc-only' | 'unresolved';
      readonly resolvedFilePath?: string;
      readonly targetPackageName: string;
    }
  > {
  readonly packageName: string;
}

export interface GraphWorkspacePackageNameMissingFinding
  extends GraphFindingBase<
    typeof LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
    {
      readonly packageManifestPath: string;
      readonly packageRole: 'referenced' | 'referencing';
      readonly referencedProjectPath: string;
      readonly referencingProjectPath: string;
    }
  > {
  readonly packageManifestPath: string;
}

export type GraphFinding =
  | GraphAccessDeniedFinding
  | GraphConditionDomainMismatchFinding
  | GraphConfigInvalidFinding
  | GraphImportTargetUnmappedFinding
  | GraphReferenceCycleFinding
  | GraphReferenceExtraFinding
  | GraphReferenceMissingFinding
  | GraphTargetUnreachableFinding
  | GraphWorkspaceDependencyUndeclaredFinding
  | GraphWorkspaceImportOutsideGraphFinding
  | GraphWorkspaceImportUnresolvedFinding
  | GraphWorkspacePackageNameMissingFinding;

export type GraphFindingForCode<Code extends GraphSemanticIssueCode> = Extract<
  GraphFinding,
  { readonly code: Code }
>;

export function createGraphCheckIssueFromFinding(options: {
  config: ResolvedLiminaConfig;
  finding: GraphFinding;
}): CanonicalLiminaCheckIssue {
  const packageManifestPath =
    'packageManifestPath' in options.finding
      ? options.finding.packageManifestPath
      : undefined;
  const packageName =
    'packageName' in options.finding ? options.finding.packageName : undefined;

  return createTaskFailureIssue({
    checkerName: options.finding.checkerName,
    code: options.finding.code,
    detailLines: options.finding.presentation.detailLines,
    evidence: options.finding.evidence,
    filePath: options.finding.filePath,
    fix: options.finding.presentation.fix,
    locations: options.finding.locations,
    packageManifestPath,
    packageName,
    reason: options.finding.presentation.reason,
    rootDir: options.config.rootDir,
    task: options.finding.task,
    title: options.finding.presentation.title,
  });
}

export function createGraphCheckIssuesFromFindings(options: {
  config: ResolvedLiminaConfig;
  findings: readonly GraphFinding[];
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createGraphCheckIssueFromFinding({
      config: options.config,
      finding,
    }),
  );
}
