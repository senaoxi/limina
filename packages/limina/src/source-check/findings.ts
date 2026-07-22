import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import type {
  CanonicalLiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
} from './snapshot';

export type SourceSemanticIssueCode =
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency;

export const SOURCE_SEMANTIC_ISSUE_CODES: readonly SourceSemanticIssueCode[] = [
  LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
  LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
  LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
  LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
  LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
  LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
  LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
  LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
  LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
  LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized,
  LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
  LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
  LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
  LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
  LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
  LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
] satisfies readonly LiminaWritableCheckIssueCode[];

export type SourceAmbientDeclarationConfigInvalidFacts =
  | {
      readonly include: readonly string[];
      readonly kind: 'no-matches';
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
    }
  | {
      readonly declarationPath: string;
      readonly kind: 'overlapping-rules';
      readonly matchingRuleIdentities: readonly string[];
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
    }
  | {
      readonly declarationPath: string;
      readonly kind: 'invalid-declaration';
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
      readonly violation:
        | 'managed-output'
        | 'not-ambient-role'
        | 'not-declaration-file'
        | 'public-declaration-entry';
    };

export interface SourceAmbientDeclarationSharedUnauthorizedFacts {
  readonly consumers: readonly {
    readonly configPaths: readonly string[];
    readonly packageManifestPath: string;
    readonly packageName?: string;
  }[];
  readonly declarationPath: string;
  readonly kind: 'shared-across-owners';
  readonly ruleIdentity: string;
  readonly ruleIndex: number;
}

export interface SourceAmbientDeclarationReferenceUnauthorizedFacts {
  readonly declarationPath: string;
  readonly importerPath: string;
  readonly kind: 'triple-slash-path-reference';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly referenceKind: string;
  readonly ruleIdentity: string;
  readonly ruleIndex: number;
}

export interface SourceCrossGovernanceBoundaryFacts {
  readonly boundary: {
    readonly configPath?: string;
    readonly exclusion?: string;
    readonly kind: string;
    readonly rootDir: string;
  };
  readonly importerPath: string;
  readonly kind: 'cross-governance-boundary';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly resolvedTargetPath: string;
  readonly specifier: string;
}

export interface SourceImportAuthorityInvalidFacts {
  readonly field: string;
  readonly grantIndex?: number;
  readonly kind:
    | 'allow-field'
    | 'grant'
    | 'grant-include'
    | 'grant-packages'
    | 'grant-reason'
    | 'root-dependency-grants'
    | 'unknown-owner';
  readonly ownerIdentity?: string;
  readonly packageManifestPath?: string;
  readonly suggestion?: string;
  readonly value?: unknown;
}

export interface SourceKnipBuildScriptUnsupportedFacts {
  readonly command?: string;
  readonly kind: 'unsupported-build-script';
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly scriptName?: string;
}

export interface SourceKnipConfigInvalidFacts {
  readonly dependencyName?: string;
  readonly field: string;
  readonly file?: string;
  readonly importerName?: string;
  readonly kind: 'dependency-ignore' | 'entry' | 'file-ignore' | 'workspace';
  readonly packageName?: string;
  readonly value?: unknown;
}

export type SourceOwnerInvalidFacts =
  | {
      readonly configPath: string;
      readonly filePaths: readonly string[];
      readonly kind: 'missing-owner';
      readonly role: 'declaration leaf' | 'typecheck companion';
    }
  | {
      readonly importerPath: string;
      readonly kind: 'outside-activated-region';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedTargetPath: string;
      readonly specifier: string;
    }
  | {
      readonly filePath: string;
      readonly kind: 'multiple-owners';
      readonly packageManifestPaths: readonly string[];
    };

export type SourcePackageImportInvalidFacts =
  | {
      readonly importerPath: string;
      readonly kind: 'resolved-package-name-missing';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedPackageManifestPath: string;
      readonly specifier: string;
    }
  | {
      readonly importerPath: string;
      readonly kind: 'specifier-unauthorized' | 'specifier-unresolved';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly specifier: string;
    }
  | {
      readonly importerPath: string;
      readonly kind:
        | 'other-owner-target'
        | 'outside-source-ownership'
        | 'target-escapes-package-scope';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedTargetPath: string;
      readonly specifier: string;
      readonly targetPackageManifestPath?: string;
      readonly targetPackageName?: string;
    };

export interface SourcePackageImportUnauthorizedFacts {
  readonly authorityManifestPaths: readonly string[];
  readonly authorityReason?: string;
  readonly dependencyName: string;
  readonly dependencySpecifier?: string;
  readonly importerPath: string;
  readonly intermediateDependencyName?: string;
  readonly kind: 'bare-package-import';
  readonly line: number;
  readonly ownerIdentity: string;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly specifier: string;
  readonly workspacePackageName?: string;
}

export interface SourceRelativeImportEscapesScopeFacts {
  readonly importerPath: string;
  readonly kind: 'relative-import';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly packageScopeManifestPath?: string;
  readonly resolvedTargetPath: string;
  readonly specifier: string;
  readonly targetPackageManifestPath?: string;
}

type SourceResourceTypeEvidenceKind =
  | 'ambient'
  | 'checker-source'
  | 'concrete-declaration'
  | 'missing'
  | 'unsupported-checker';

export interface SourceResourceModuleNotFoundFacts {
  readonly checkedPath?: string;
  readonly checkerName: string;
  readonly configPath: string;
  readonly importerPath: string;
  readonly kind: 'resource-module-not-found';
  readonly line: number;
  readonly specifier: string;
  readonly typeEvidenceKind: SourceResourceTypeEvidenceKind;
}

export interface SourceResourceModuleTypeUndeclaredFacts {
  readonly checkerName: string;
  readonly configPath: string;
  readonly importerPath: string;
  readonly kind: 'resource-module-type-undeclared';
  readonly line: number;
  readonly runtimeAuthority: 'filesystem' | 'oxc' | 'package-export';
  readonly runtimeFilePath: string;
  readonly specifier: string;
  readonly typeEvidenceKind: 'missing';
}

export type SourceTsconfigGovernanceFacts =
  | {
      readonly checkerName: string;
      readonly configPath?: string;
      readonly kind: 'checker-route';
    }
  | {
      readonly configPath: string;
      readonly field: string;
      readonly kind: 'project-label';
      readonly value?: unknown;
    }
  | {
      readonly configPath: string;
      readonly filePaths?: readonly string[];
      readonly kind:
        | 'config-missing-owner'
        | 'config-mixed-owners'
        | 'config-owner-scope';
      readonly packageManifestPaths?: readonly string[];
      readonly role?: 'declaration leaf' | 'typecheck companion';
    }
  | {
      readonly candidateConfigPaths: readonly string[];
      readonly filePath: string;
      readonly kind: 'module-owner-unresolved';
      readonly matchedConfigPaths: readonly string[];
      readonly resolverConfigPath?: string;
      readonly status: 'missing' | 'multiple' | 'unmatched';
    }
  | {
      readonly configPaths: readonly string[];
      readonly filePath: string;
      readonly kind: 'multiple-governance-units';
    };

export interface SourceUnusedModuleFacts {
  readonly filePath: string;
  readonly kind: 'unused-module';
  readonly ownerDirectory: string;
  readonly packageManifestPath: string;
  readonly packageName: string;
}

export interface SourceUnusedWorkspaceDependencyFacts {
  readonly dependencyName: string;
  readonly kind: 'unused-workspace-dependency';
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly sectionName: string;
  readonly specifier: string;
}

export interface SourceFindingFactsByCode {
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid]: SourceAmbientDeclarationConfigInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized]: SourceAmbientDeclarationReferenceUnauthorizedFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized]: SourceAmbientDeclarationSharedUnauthorizedFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary]: SourceCrossGovernanceBoundaryFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]: SourceImportAuthorityInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported]: SourceKnipBuildScriptUnsupportedFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid]: SourceKnipConfigInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid]: SourceOwnerInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid]: SourcePackageImportInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized]: SourcePackageImportUnauthorizedFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope]: SourceRelativeImportEscapesScopeFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound]: SourceResourceModuleNotFoundFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared]: SourceResourceModuleTypeUndeclaredFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance]: SourceTsconfigGovernanceFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule]: SourceUnusedModuleFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency]: SourceUnusedWorkspaceDependencyFacts;
}

interface SourceFindingBase<Code extends SourceSemanticIssueCode> {
  readonly checkerName?: string;
  readonly code: Code;
  readonly detailLines?: readonly string[];
  readonly detector?: string;
  readonly evidence: readonly LiminaCheckIssueEvidence[];
  readonly external?: LiminaCheckIssueExternal;
  readonly facts: SourceFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly fix?: string;
  readonly fixSteps?: readonly string[];
  readonly locations?: readonly LiminaCheckIssueLocation[];
  readonly ownerName: string;
  readonly packageJsonPath?: string;
  readonly reason: string;
  readonly scope?: string;
  readonly summary?: string;
  readonly task: 'source:check';
  readonly title: string;
  readonly tool?: string;
  readonly verifyCommands?: readonly string[];
}

type SourceFindingFields<Code extends SourceSemanticIssueCode> =
  Code extends typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
    ? {
        readonly filePath: string;
        readonly ownerDirectory: string;
        readonly ownerName: string;
        readonly packageJsonPath: string;
      }
    : Code extends typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency
      ? {
          readonly dependencyName: string;
          readonly ownerName: string;
          readonly packageJsonPath: string;
          readonly sectionName: string;
          readonly specifier: string;
        }
      : object;

export type SourceFindingForCode<Code extends SourceSemanticIssueCode> =
  SourceFindingBase<Code> & SourceFindingFields<Code>;

export type SourceFinding = {
  readonly [Code in SourceSemanticIssueCode]: SourceFindingForCode<Code>;
}[SourceSemanticIssueCode];

export type SourceStructuredIssueCode = Exclude<
  SourceSemanticIssueCode,
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
  | typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency
>;

export type SourceUnusedModuleFinding = SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
>;
export type SourceUnusedWorkspaceDependencyFinding = SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency
>;
export type SourceStructuredFinding = {
  readonly [Code in SourceStructuredIssueCode]: SourceFindingForCode<Code>;
}[SourceStructuredIssueCode];

export function defineSourceFinding<Code extends SourceSemanticIssueCode>(
  finding: SourceFindingForCode<Code>,
): SourceFindingForCode<Code> {
  return finding;
}

export function createSourceKnipConfigFinding(options: {
  dependencyName?: string;
  field: string;
  file?: string;
  importerName?: string;
  kind: SourceKnipConfigInvalidFacts['kind'];
  lines: readonly string[];
  packageJsonPath?: string;
  packageName?: string;
  reason: string;
  title: string;
  value?: unknown;
}): SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid
> {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines: [...options.lines] }],
    external: { tool: 'knip' },
    facts: {
      dependencyName: options.dependencyName,
      field: options.field,
      file: options.file,
      importerName: options.importerName,
      kind: options.kind,
      packageName: options.packageName,
      value: options.value,
    },
    locations: [{ label: 'field', scope: options.field }],
    ownerName: options.packageName ?? '<workspace>',
    packageJsonPath: options.packageJsonPath,
    reason: options.reason,
    scope: options.field,
    summary: options.title,
    task: 'source:check',
    title: options.title,
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceUnusedModuleFinding(options: {
  externalCode: string;
  externalMessage?: string;
  filePath: string;
  ownerDirectory: string;
  ownerName: string;
  packageJsonPath: string;
}): SourceUnusedModuleFinding {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
    detector: 'knip',
    evidence: [],
    external: {
      code: options.externalCode,
      message: options.externalMessage,
      tool: 'knip',
    },
    facts: {
      filePath: options.filePath,
      kind: 'unused-module',
      ownerDirectory: options.ownerDirectory,
      packageManifestPath: options.packageJsonPath,
      packageName: options.ownerName,
    },
    filePath: options.filePath,
    fixSteps: [
      'Delete files that are truly unused.',
      'Make files reachable from package manifest entries, binaries, scripts, or Knip plugin entries.',
      `Add intentional files to source.knip.workspaces["${options.ownerName}"].ignoreFiles with a reason.`,
    ],
    ownerDirectory: options.ownerDirectory,
    ownerName: options.ownerName,
    packageJsonPath: options.packageJsonPath,
    reason:
      'Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.',
    summary: 'Unused source module is not reachable from package entry points.',
    task: 'source:check',
    title: 'Unused source module',
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceUnusedWorkspaceDependencyFinding(options: {
  dependencyName: string;
  externalCode: string;
  externalMessage?: string;
  ownerName: string;
  packageJsonPath: string;
  sectionName: string;
  specifier: string;
}): SourceUnusedWorkspaceDependencyFinding {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
    dependencyName: options.dependencyName,
    detector: 'knip',
    evidence: [
      {
        label: 'dependency',
        value: `${options.dependencyName} (${options.sectionName}: ${options.specifier})`,
      },
    ],
    external: {
      code: options.externalCode,
      message: options.externalMessage,
      tool: 'knip',
    },
    facts: {
      dependencyName: options.dependencyName,
      kind: 'unused-workspace-dependency',
      packageManifestPath: options.packageJsonPath,
      packageName: options.ownerName,
      sectionName: options.sectionName,
      specifier: options.specifier,
    },
    fixSteps: [
      'Remove dependencies that are truly unused from the package manifest.',
      'Make dependencies reachable from package entries, binaries, scripts, or Knip plugin entries.',
      `Add intentional dependencies to source.knip.workspaces["${options.ownerName}"].ignoreDependencies with dep and reason.`,
    ],
    ownerName: options.ownerName,
    packageJsonPath: options.packageJsonPath,
    reason:
      'Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
    sectionName: options.sectionName,
    specifier: options.specifier,
    summary: 'Workspace package dependency is not visible to source analysis.',
    task: 'source:check',
    title: 'Unused workspace dependency',
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceCheckIssueFromFinding(options: {
  finding: SourceFinding;
  rootDir: string;
}): CanonicalLiminaCheckIssue {
  return createLiminaCheckIssue({
    checkerName: options.finding.checkerName,
    code: options.finding.code,
    detailLines: options.finding.detailLines,
    detector: options.finding.detector,
    domain: 'source',
    evidence: options.finding.evidence,
    external: options.finding.external,
    filePath: options.finding.filePath,
    fix: options.finding.fix,
    fixSteps: options.finding.fixSteps,
    locations: options.finding.locations,
    packageManifestPath: options.finding.packageJsonPath,
    packageName: options.finding.ownerName,
    reason: options.finding.reason,
    rootDir: options.rootDir,
    scope: options.finding.scope,
    summary: options.finding.summary,
    task: options.finding.task,
    title: options.finding.title,
    tool: options.finding.tool,
    verifyCommands: options.finding.verifyCommands,
  });
}

export function createSourceCheckIssuesFromFindings(options: {
  findings: readonly SourceFinding[];
  rootDir: string;
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createSourceCheckIssueFromFinding({
      finding,
      rootDir: options.rootDir,
    }),
  );
}
