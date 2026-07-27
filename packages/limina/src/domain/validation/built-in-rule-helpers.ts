import type { PackageId } from '../shared/identifiers';
import type { ValidationContext } from './contracts';
import { locationFromFile, locationFromProject } from './helpers';
import type {
  DeclarationBuildValidationView,
  ImportFactsValidationView,
  ImportFactValidationOccurrence,
  OutputBuildValidationEdge,
  OutputBuildValidationView,
  PackageArtifactValidationEdge,
  PackageArtifactValidationView,
  ProjectOwnershipConflict,
  ProjectValidationView,
  SourceDependencyValidationEdge,
  SourceDependencyValidationView,
  ValidationPackageExport,
  WorkspaceValidationRegion,
  WorkspaceValidationView,
} from './views';

function incrementMembership(
  memberships: Map<string, number>,
  packageId: string,
): void {
  const current = memberships.get(packageId);
  memberships.set(packageId, current === undefined ? 1 : current + 1);
}

function collectRegionMemberships(
  regions: readonly WorkspaceValidationRegion[],
): Map<string, number> {
  const memberships = new Map<string, number>();

  for (const region of regions) {
    for (const packageId of region.packageIds) {
      incrementMembership(memberships, packageId);
    }
  }

  return memberships;
}

function membershipCount(
  memberships: ReadonlyMap<string, number>,
  packageId: string,
): number {
  const count = memberships.get(packageId);
  return count === undefined ? 0 : count;
}

function reportRegionMembership(
  context: ValidationContext<'missing' | 'multiple'>,
  packageId: string,
  count: number,
): void {
  if (count === 0) {
    context.report({ messageId: 'missing', values: { packageId } });
    return;
  }

  if (count > 1) {
    context.report({ messageId: 'multiple', values: { packageId } });
  }
}

export function validateWorkspaceRegionMembership(
  view: WorkspaceValidationView,
  context: ValidationContext<'missing' | 'multiple'>,
): void {
  const memberships = collectRegionMemberships(view.regions);

  for (const packageId of Object.keys(view.packages).sort()) {
    reportRegionMembership(
      context,
      packageId,
      membershipCount(memberships, packageId),
    );
  }
}

function reportOwnershipConflict(
  view: ProjectValidationView,
  context: ValidationContext<'conflict'>,
  conflict: ProjectOwnershipConflict,
): void {
  const file = view.files[conflict.fileId];

  context.report({
    location: file ? locationFromFile(file) : undefined,
    messageId: 'conflict',
    values: {
      candidates: conflict.candidateProjectIds.join(', '),
      fileId: conflict.fileId,
      kind: conflict.kind,
    },
  });
}

export function validateProjectOwnershipConflicts(
  view: ProjectValidationView,
  context: ValidationContext<'conflict'>,
): void {
  for (const conflict of view.ownershipConflicts) {
    reportOwnershipConflict(view, context, conflict);
  }
}

function reportMissingImportEvidence(
  view: ImportFactsValidationView,
  context: ValidationContext<'missing-evidence'>,
  occurrence: ImportFactValidationOccurrence,
): void {
  const file = view.files[occurrence.fileId];

  context.report({
    location: file ? locationFromFile(file) : undefined,
    messageId: 'missing-evidence',
    values: {
      fileId: occurrence.fileId,
      specifier: occurrence.specifier,
    },
  });
}

export function validateImportEvidenceIntegrity(
  view: ImportFactsValidationView,
  context: ValidationContext<'missing-evidence'>,
): void {
  for (const occurrence of view.occurrences) {
    if (occurrence.evidenceId.length === 0) {
      reportMissingImportEvidence(view, context, occurrence);
    }
  }
}

function reportUnresolvedSourceDependency(
  view: SourceDependencyValidationView,
  context: ValidationContext<'unresolved'>,
  edge: SourceDependencyValidationEdge,
): void {
  if (edge.target.kind !== 'unresolved') {
    return;
  }

  const project = view.projects[edge.fromProjectId];
  context.report({
    location: project ? locationFromProject(project) : undefined,
    messageId: 'unresolved',
    values: {
      projectId: edge.fromProjectId,
      specifier: edge.target.specifier,
    },
  });
}

export function validateSourceDependencyResolution(
  view: SourceDependencyValidationView,
  context: ValidationContext<'unresolved'>,
): void {
  for (const edge of view.edges) {
    reportUnresolvedSourceDependency(view, context, edge);
  }
}

function reportCycle(
  context: ValidationContext<'cycle'>,
  component: readonly string[],
): void {
  if (component.length < 2) {
    return;
  }

  context.report({
    messageId: 'cycle',
    values: { projects: component.join(' -> ') },
  });
}

export function validateDeclarationCycles(
  view: DeclarationBuildValidationView,
  context: ValidationContext<'cycle'>,
): void {
  for (const component of view.stronglyConnectedComponents) {
    reportCycle(context, component);
  }
}

function reportOutputBuildSelfEdge(
  context: ValidationContext<'self-edge'>,
  edge: OutputBuildValidationEdge,
): void {
  if (edge.fromPackageId !== edge.toPackageId) {
    return;
  }

  context.report({
    messageId: 'self-edge',
    values: { packageId: edge.fromPackageId },
  });
}

export function validateOutputBuildSelfEdges(
  view: OutputBuildValidationView,
  context: ValidationContext<'self-edge'>,
): void {
  for (const edge of view.edges) {
    reportOutputBuildSelfEdge(context, edge);
  }
}

function findSelectedExport(
  view: PackageArtifactValidationView,
  edge: PackageArtifactValidationEdge,
): ValidationPackageExport | undefined {
  if (!edge.selectedSubpath) {
    return undefined;
  }

  return view.packages[edge.toPackageId]?.exports.find(
    (entry) => entry.subpath === edge.selectedSubpath,
  );
}

function reportDeniedPackageExport(
  context: ValidationContext<'denied-export'>,
  packageId: PackageId,
  subpath: string,
): void {
  context.report({
    messageId: 'denied-export',
    values: { packageId, subpath },
  });
}

function getDeniedSelectedSubpath(
  view: PackageArtifactValidationView,
  edge: PackageArtifactValidationEdge,
): string | undefined {
  const selectedExport = findSelectedExport(view, edge);

  return selectedExport?.access === 'denied' ? edge.selectedSubpath : undefined;
}

function validatePackageArtifactEdge(
  view: PackageArtifactValidationView,
  context: ValidationContext<'denied-export'>,
  edge: PackageArtifactValidationEdge,
): void {
  const deniedSubpath = getDeniedSelectedSubpath(view, edge);

  if (deniedSubpath) {
    reportDeniedPackageExport(context, edge.toPackageId, deniedSubpath);
  }
}

export function validatePackageArtifactAccess(
  view: PackageArtifactValidationView,
  context: ValidationContext<'denied-export'>,
): void {
  for (const edge of view.edges) {
    validatePackageArtifactEdge(view, context, edge);
  }
}
