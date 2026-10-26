import type { PackageId } from '../shared/identifiers';
import type {
  TypedValidatorRegistration,
  ValidationContext,
} from './contracts';
import { createNoOptionsDescriptor } from './descriptors';
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

function validateWorkspaceRegionMembership(
  view: WorkspaceValidationView,
  context: ValidationContext<'missing' | 'multiple'>,
): void {
  const memberships = collectRegionMemberships(view.regions);

  const orderedEntries = Object.keys(view.packages).sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
  for (const packageId of orderedEntries) {
    reportRegionMembership(
      context,
      packageId,
      membershipCount(memberships, packageId),
    );
  }
}

export const workspaceRegionMembershipRule: TypedValidatorRegistration<
  'workspace',
  WorkspaceValidationView,
  undefined,
  'missing' | 'multiple'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'workspace',
    description: 'Every activated workspace package belongs to one region.',
    documentation: 'https://senao.me/repos/limina/config/regions',
    id: 'workspace/package-region-membership',
    inputKind: 'workspace',
    messages: {
      missing: {
        text: 'Package {packageId} is not assigned to an activated region.',
        title: 'Workspace package has no region',
      },
      multiple: {
        text: 'Package {packageId} is assigned to multiple regions.',
        title: 'Workspace package has multiple regions',
      },
    },
  }),
  validate: validateWorkspaceRegionMembership,
};

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

function validateProjectOwnershipConflicts(
  view: ProjectValidationView,
  context: ValidationContext<'conflict'>,
): void {
  for (const conflict of view.ownershipConflicts) {
    reportOwnershipConflict(view, context, conflict);
  }
}

export const projectOwnershipConflictRule: TypedValidatorRegistration<
  'projects',
  ProjectValidationView,
  undefined,
  'conflict'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'ownership',
    description: 'Unique ownership domains reject conflicting candidates.',
    documentation: 'https://senao.me/repos/limina/concepts',
    id: 'projects/ownership-conflict',
    inputKind: 'projects',
    messages: {
      conflict: {
        text: '{kind} ownership for {fileId} has candidates: {candidates}.',
        title: 'Ownership conflict',
      },
    },
  }),
  validate: validateProjectOwnershipConflicts,
};

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

function validateImportEvidenceIntegrity(
  view: ImportFactsValidationView,
  context: ValidationContext<'missing-evidence'>,
): void {
  for (const occurrence of view.occurrences) {
    if (occurrence.evidenceId.length === 0) {
      reportMissingImportEvidence(view, context, occurrence);
    }
  }
}

export const importEvidenceIntegrityRule: TypedValidatorRegistration<
  'import-facts',
  ImportFactsValidationView,
  undefined,
  'missing-evidence'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'dependency',
    description: 'Every import occurrence has stable evidence identity.',
    documentation:
      'https://senao.me/repos/limina/import-resolution-to-declaration-build-graph',
    id: 'imports/evidence-integrity',
    inputKind: 'import-facts',
    messages: {
      'missing-evidence': {
        text: 'Import {specifier} in {fileId} has no evidence identity.',
        title: 'Import evidence is incomplete',
      },
    },
  }),
  validate: validateImportEvidenceIntegrity,
};

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

function validateSourceDependencyResolution(
  view: SourceDependencyValidationView,
  context: ValidationContext<'unresolved'>,
): void {
  for (const edge of view.edges) {
    reportUnresolvedSourceDependency(view, context, edge);
  }
}

export const sourceDependencyResolutionRule: TypedValidatorRegistration<
  'source-dependencies',
  SourceDependencyValidationView,
  undefined,
  'unresolved'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'dependency',
    description: 'Governed source dependencies must have classified targets.',
    documentation:
      'https://senao.me/repos/limina/import-resolution-to-declaration-build-graph',
    id: 'source-dependencies/unresolved-target',
    inputKind: 'source-dependencies',
    messages: {
      unresolved: {
        text: '{projectId} imports unresolved specifier {specifier}.',
        title: 'Source dependency is unresolved',
      },
    },
  }),
  validate: validateSourceDependencyResolution,
};

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

function validateDeclarationCycles(
  view: DeclarationBuildValidationView,
  context: ValidationContext<'cycle'>,
): void {
  for (const component of view.stronglyConnectedComponents) {
    reportCycle(context, component);
  }
}

export const declarationCycleRule: TypedValidatorRegistration<
  'declaration-build',
  DeclarationBuildValidationView,
  undefined,
  'cycle'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'build',
    description: 'Declaration build references must be acyclic.',
    documentation: 'https://senao.me/repos/limina/why-import-is-not-references',
    id: 'declaration-build/cycle',
    inputKind: 'declaration-build',
    messages: {
      cycle: {
        text: 'Declaration build cycle: {projects}.',
        title: 'Declaration build contains a cycle',
      },
    },
  }),
  validate: validateDeclarationCycles,
};

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

function validateOutputBuildSelfEdges(
  view: OutputBuildValidationView,
  context: ValidationContext<'self-edge'>,
): void {
  for (const edge of view.edges) {
    reportOutputBuildSelfEdge(context, edge);
  }
}

export const outputBuildSelfEdgeRule: TypedValidatorRegistration<
  'output-build',
  OutputBuildValidationView,
  undefined,
  'self-edge'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'build',
    description: 'Output-build dependencies cannot point to the same package.',
    documentation: 'https://senao.me/repos/limina/workflows',
    id: 'output-build/self-edge',
    inputKind: 'output-build',
    messages: {
      'self-edge': {
        text: 'Package {packageId} contains a self-referential output edge.',
        title: 'Output build edge is self-referential',
      },
    },
  }),
  validate: validateOutputBuildSelfEdges,
};

function findSelectedExport(
  view: PackageArtifactValidationView,
  edge: PackageArtifactValidationEdge,
): ValidationPackageExport | undefined {
  return edge.selectedSubpath
    ? view.packages[edge.toPackageId]?.exports.find(
        (entry) => entry.subpath === edge.selectedSubpath,
      )
    : undefined;
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

function validatePackageArtifactAccess(
  view: PackageArtifactValidationView,
  context: ValidationContext<'denied-export'>,
): void {
  for (const edge of view.edges) {
    validatePackageArtifactEdge(view, context, edge);
  }
}

export const packageArtifactAccessRule: TypedValidatorRegistration<
  'package-artifacts',
  PackageArtifactValidationView,
  undefined,
  'denied-export'
> = {
  descriptor: createNoOptionsDescriptor({
    category: 'architecture',
    description: 'Package artifact edges use accessible public exports.',
    documentation: 'https://senao.me/repos/limina/monorepo-constraints',
    id: 'package-artifacts/public-export',
    inputKind: 'package-artifacts',
    messages: {
      'denied-export': {
        text: 'Package {packageId} subpath {subpath} is not publicly accessible.',
        title: 'Package export access denied',
      },
    },
  }),
  validate: validatePackageArtifactAccess,
};

export type BuiltInArchitectureValidator =
  | typeof declarationCycleRule
  | typeof importEvidenceIntegrityRule
  | typeof outputBuildSelfEdgeRule
  | typeof packageArtifactAccessRule
  | typeof projectOwnershipConflictRule
  | typeof sourceDependencyResolutionRule
  | typeof workspaceRegionMembershipRule;

export const builtInArchitectureValidators: readonly BuiltInArchitectureValidator[] =
  Object.freeze([
    workspaceRegionMembershipRule,
    projectOwnershipConflictRule,
    importEvidenceIntegrityRule,
    sourceDependencyResolutionRule,
    declarationCycleRule,
    outputBuildSelfEdgeRule,
    packageArtifactAccessRule,
  ]);
