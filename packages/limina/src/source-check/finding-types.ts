import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import type {
  SourceAmbientDeclarationConfigInvalidFacts,
  SourceAmbientDeclarationReferenceUnauthorizedFacts,
  SourceAmbientDeclarationSharedUnauthorizedFacts,
  SourceCrossGovernanceBoundaryFacts,
  SourceImportAuthorityInvalidFacts,
  SourceKnipBuildScriptUnsupportedFacts,
  SourceKnipConfigInvalidFacts,
  SourceOwnerInvalidFacts,
  SourcePackageImportInvalidFacts,
  SourcePackageImportUnauthorizedFacts,
  SourceRelativeImportEscapesScopeFacts,
  SourceResourceModuleNotFoundFacts,
  SourceResourceModuleTypeUndeclaredFacts,
  SourceTsconfigGovernanceFacts,
  SourceUnusedModuleFacts,
  SourceUnusedWorkspaceDependencyFacts,
} from './finding-facts';
import type {
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
} from './snapshot';

export type * from './finding-facts';

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
