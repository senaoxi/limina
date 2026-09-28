import type {
  CheckerId,
  DeclarationBuildEdgeId,
  EvidenceId,
  FileId,
  LocationId,
  OutputBuildEdgeId,
  PackageArtifactEdgeId,
  PackageId,
  ProjectId,
  SourceDependencyEdgeId,
  WorkspaceRegionId,
} from '../shared/identifiers';
import type { SourceDependencyTarget } from '../validation/views';

export interface WorkspaceRegion {
  readonly boundaryPaths: readonly string[];
  readonly exclusionProvenance: readonly string[];
  readonly id: WorkspaceRegionId;
  readonly packageIds: readonly PackageId[];
  readonly rootPath: string;
}

export interface WorkspaceTopology {
  readonly packageIds: readonly PackageId[];
  readonly regions: readonly WorkspaceRegion[];
}

export interface OwnershipConflict {
  readonly candidateProjectIds: readonly ProjectId[];
  readonly fileId: FileId;
  readonly kind: 'checker' | 'output' | 'source';
}

export interface ProjectCatalog {
  readonly fileIds: readonly FileId[];
  readonly ownershipConflicts: readonly OwnershipConflict[];
  readonly projectIds: readonly ProjectId[];
}

export interface ImportOccurrence {
  readonly evidenceId: EvidenceId;
  readonly fileId: FileId;
  readonly locationId?: LocationId;
  readonly resolvedTargetFileId?: FileId;
  readonly specifier: string;
  readonly syntaxKind: string;
}

export interface ImportFacts {
  readonly occurrences: readonly ImportOccurrence[];
}

export interface SourceDependencyEdge {
  readonly evidenceIds: readonly EvidenceId[];
  readonly fromFileId: FileId;
  readonly fromPackageId?: PackageId;
  readonly fromProjectId: ProjectId;
  readonly id: SourceDependencyEdgeId;
  readonly kind: 'dynamic' | 'runtime' | 'type';
  readonly target: SourceDependencyTarget;
}

export interface SourceDependencyGraph {
  readonly edges: readonly SourceDependencyEdge[];
  readonly evidence: readonly SourceDependencyEvidence[];
  readonly roots: readonly ProjectId[];
}

export interface SourceDependencyEvidence {
  readonly id: EvidenceId;
  readonly kind: string;
  readonly locationId?: LocationId;
  readonly value: string;
}

export interface DeclarationBuildEdge {
  readonly checkerId: CheckerId;
  readonly fromProjectId: ProjectId;
  readonly id: DeclarationBuildEdgeId;
  readonly kind: 'provider' | 'reference';
  readonly toProjectId: ProjectId;
}

export interface DeclarationBuildGraph {
  readonly edges: readonly DeclarationBuildEdge[];
  readonly stronglyConnectedComponents: readonly (readonly ProjectId[])[];
}

export interface OutputBuildEdge {
  readonly fromPackageId: PackageId;
  readonly id: OutputBuildEdgeId;
  readonly kind: 'builds' | 'consumes';
  readonly toPackageId: PackageId;
}

export interface OutputBuildGraph {
  readonly edges: readonly OutputBuildEdge[];
}

export interface PackageArtifactEdge {
  readonly fromPackageId: PackageId;
  readonly id: PackageArtifactEdgeId;
  readonly kind:
    | 'artifact-consumption'
    | 'public-export'
    | 'source-consumption';
  readonly selectedSubpath?: string;
  readonly toPackageId: PackageId;
}

export interface PackageArtifactGraph {
  readonly edges: readonly PackageArtifactEdge[];
}

export interface PackageOutputFinding {
  readonly code: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly packageId: PackageId;
  readonly tool?: string;
}

export interface PackageOutput {
  readonly findings: readonly PackageOutputFinding[];
}

export interface ReleaseAssessmentFinding {
  readonly code: string;
  readonly packageId: PackageId;
  readonly publishedVersion?: string;
  readonly registry?: string;
}

export interface ReleaseAssessment {
  readonly findings: readonly ReleaseAssessmentFinding[];
}
