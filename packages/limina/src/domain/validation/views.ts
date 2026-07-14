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

export interface ValidationFile {
  readonly id: FileId;
  readonly packageId?: PackageId;
  readonly path: string;
  readonly projectId?: ProjectId;
}

export interface ValidationProject {
  readonly checkerIds: readonly CheckerId[];
  readonly configPath: string;
  readonly domain?: string;
  readonly id: ProjectId;
  readonly labels: readonly string[];
  readonly name: string;
  readonly packageId?: PackageId;
  readonly team?: string;
}

export interface ValidationPackageExport {
  readonly access: 'allowed' | 'denied' | 'unresolved';
  readonly resolvedTargetKind?: 'declaration' | 'runtime' | 'source';
  readonly subpath: string;
  readonly targets: readonly string[];
}

export interface ValidationPackage {
  readonly exports: readonly ValidationPackageExport[];
  readonly id: PackageId;
  readonly labels: readonly string[];
  readonly name?: string;
  readonly role?: 'application' | 'contract' | 'library' | 'tooling';
  readonly rootPath: string;
}

export interface ValidationLocation {
  readonly column?: number;
  readonly fileId: FileId;
  readonly id: LocationId;
  readonly line?: number;
}

export interface ValidationEvidence {
  readonly id: EvidenceId;
  readonly kind: string;
  readonly locationId?: LocationId;
  readonly value: string;
}

export interface ValidationEntityReferences {
  readonly files: Readonly<Record<FileId, ValidationFile>>;
  readonly locations: Readonly<Record<LocationId, ValidationLocation>>;
  readonly packages: Readonly<Record<PackageId, ValidationPackage>>;
  readonly projects: Readonly<Record<ProjectId, ValidationProject>>;
}

export interface WorkspaceValidationRegion {
  readonly boundaryPaths: readonly string[];
  readonly exclusionProvenance: readonly string[];
  readonly id: WorkspaceRegionId;
  readonly packageIds: readonly PackageId[];
  readonly rootPath: string;
}

export interface WorkspaceValidationView {
  readonly kind: 'workspace';
  readonly packages: Readonly<Record<PackageId, ValidationPackage>>;
  readonly regions: readonly WorkspaceValidationRegion[];
}

export interface ProjectOwnershipConflict {
  readonly candidateProjectIds: readonly ProjectId[];
  readonly fileId: FileId;
  readonly kind: 'checker' | 'output' | 'source';
}

export interface ProjectValidationView extends ValidationEntityReferences {
  readonly kind: 'projects';
  readonly ownershipConflicts: readonly ProjectOwnershipConflict[];
}

export interface ImportFactValidationOccurrence {
  readonly evidenceId: EvidenceId;
  readonly fileId: FileId;
  readonly locationId?: LocationId;
  readonly resolvedTargetFileId?: FileId;
  readonly specifier: string;
  readonly syntaxKind: string;
}

export interface ImportFactsValidationView extends ValidationEntityReferences {
  readonly kind: 'import-facts';
  readonly occurrences: readonly ImportFactValidationOccurrence[];
}

export type SourceDependencyTarget =
  | { readonly kind: 'external-package'; readonly packageName: string }
  | { readonly kind: 'node-builtin'; readonly specifier: string }
  | {
      readonly fileId: FileId;
      readonly kind: 'workspace-file';
      readonly packageId?: PackageId;
      readonly projectId?: ProjectId;
    }
  | { readonly kind: 'unresolved'; readonly specifier: string };

export interface SourceDependencyValidationEdge {
  readonly boundary: {
    readonly domain: 'cross' | 'same' | 'unclassified';
    readonly team: 'cross' | 'same' | 'unclassified';
  };
  readonly evidenceIds: readonly EvidenceId[];
  readonly fromFileId: FileId;
  readonly fromPackageId?: PackageId;
  readonly fromProjectId: ProjectId;
  readonly id: SourceDependencyEdgeId;
  readonly kind: 'dynamic' | 'runtime' | 'type';
  readonly target: SourceDependencyTarget;
}

export interface SourceDependencyValidationView
  extends ValidationEntityReferences {
  readonly edges: readonly SourceDependencyValidationEdge[];
  readonly evidence: Readonly<Record<EvidenceId, ValidationEvidence>>;
  readonly kind: 'source-dependencies';
  readonly roots: readonly ProjectId[];
}

export interface DeclarationBuildValidationEdge {
  readonly checkerId: CheckerId;
  readonly fromProjectId: ProjectId;
  readonly id: DeclarationBuildEdgeId;
  readonly kind: 'provider' | 'reference';
  readonly toProjectId: ProjectId;
}

export interface DeclarationBuildValidationView
  extends ValidationEntityReferences {
  readonly edges: readonly DeclarationBuildValidationEdge[];
  readonly kind: 'declaration-build';
  readonly stronglyConnectedComponents: readonly (readonly ProjectId[])[];
}

export interface OutputBuildValidationEdge {
  readonly fromPackageId: PackageId;
  readonly id: OutputBuildEdgeId;
  readonly kind: 'builds' | 'consumes';
  readonly toPackageId: PackageId;
}

export interface OutputBuildValidationView extends ValidationEntityReferences {
  readonly edges: readonly OutputBuildValidationEdge[];
  readonly kind: 'output-build';
}

export interface PackageArtifactValidationEdge {
  readonly fromPackageId: PackageId;
  readonly id: PackageArtifactEdgeId;
  readonly kind:
    | 'artifact-consumption'
    | 'public-export'
    | 'source-consumption';
  readonly selectedSubpath?: string;
  readonly toPackageId: PackageId;
}

export interface PackageArtifactValidationView
  extends ValidationEntityReferences {
  readonly edges: readonly PackageArtifactValidationEdge[];
  readonly kind: 'package-artifacts';
}

export interface PackageOutputFinding {
  readonly code: string;
  readonly evidence: readonly ValidationEvidence[];
  readonly packageId: PackageId;
  readonly tool?: string;
}

export interface PackageOutputValidationView
  extends ValidationEntityReferences {
  readonly findings: readonly PackageOutputFinding[];
  readonly kind: 'package-output';
}

export interface ReleaseAssessmentFinding {
  readonly code: string;
  readonly packageId: PackageId;
  readonly publishedVersion?: string;
  readonly registry?: string;
}

export interface ReleaseAssessmentValidationView
  extends ValidationEntityReferences {
  readonly findings: readonly ReleaseAssessmentFinding[];
  readonly kind: 'release-assessment';
}

export interface ValidationViewByKind {
  readonly 'declaration-build': DeclarationBuildValidationView;
  readonly 'import-facts': ImportFactsValidationView;
  readonly 'output-build': OutputBuildValidationView;
  readonly 'package-artifacts': PackageArtifactValidationView;
  readonly 'package-output': PackageOutputValidationView;
  readonly projects: ProjectValidationView;
  readonly 'release-assessment': ReleaseAssessmentValidationView;
  readonly 'source-dependencies': SourceDependencyValidationView;
  readonly workspace: WorkspaceValidationView;
}
