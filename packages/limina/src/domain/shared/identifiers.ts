/** Stable identifiers crossing aggregate and validation-view boundaries. */

declare const identifierBrand: unique symbol;

export type Identifier<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type AnalysisGeneration = Identifier<'AnalysisGeneration'>;
export type AnalysisRunId = Identifier<'AnalysisRunId'>;
export type CheckerId = Identifier<'CheckerId'>;
export type DeclarationBuildEdgeId = Identifier<'DeclarationBuildEdgeId'>;
export type EvidenceId = Identifier<'EvidenceId'>;
export type FileId = Identifier<'FileId'>;
export type GovernanceIssueId = Identifier<'GovernanceIssueId'>;
export type LocationId = Identifier<'LocationId'>;
export type OutputBuildEdgeId = Identifier<'OutputBuildEdgeId'>;
export type PackageArtifactEdgeId = Identifier<'PackageArtifactEdgeId'>;
export type PackageId = Identifier<'PackageId'>;
export type ProjectId = Identifier<'ProjectId'>;
export type RepositorySnapshotToken = Identifier<'RepositorySnapshotToken'>;
export type RuleId = Identifier<'RuleId'>;
export type SourceDependencyEdgeId = Identifier<'SourceDependencyEdgeId'>;
export type WorkspaceRegionId = Identifier<'WorkspaceRegionId'>;

export function identifier<Name extends string>(
  value: string,
): Identifier<Name> {
  if (value.length === 0) {
    throw new Error('Stable identifiers must not be empty.');
  }

  return value as Identifier<Name>;
}
