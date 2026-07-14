import { identifier } from '../shared/identifiers';
import type { RuleDescriptor, TypedValidatorRegistration } from './contracts';
import { locationFromFile, locationFromProject } from './helpers';
import type {
  DeclarationBuildValidationView,
  ImportFactsValidationView,
  OutputBuildValidationView,
  PackageArtifactValidationView,
  ProjectValidationView,
  SourceDependencyValidationView,
  WorkspaceValidationView,
} from './views';

function noOptionsDescriptor<
  const Kind extends string,
  MessageId extends string,
>(options: {
  readonly category: RuleDescriptor<Kind, undefined, MessageId>['category'];
  readonly description: string;
  readonly documentation: string;
  readonly id: string;
  readonly inputKind: Kind;
  readonly messages: RuleDescriptor<Kind, undefined, MessageId>['messages'];
}): RuleDescriptor<Kind, undefined, MessageId> {
  return Object.freeze({
    category: options.category,
    defaultSeverity: 'error',
    description: options.description,
    documentation: { url: options.documentation },
    id: identifier<'RuleId'>(options.id),
    inputKind: options.inputKind,
    messages: options.messages,
    options: { kind: 'none' } as const,
  });
}

export const workspaceRegionMembershipRule: TypedValidatorRegistration<
  'workspace',
  WorkspaceValidationView,
  undefined,
  'missing' | 'multiple'
> = {
  descriptor: noOptionsDescriptor({
    category: 'workspace',
    description: 'Every activated workspace package belongs to one region.',
    documentation: 'https://docs.senao.me/docs-islands/limina/config/regions',
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
  validate(view, context) {
    const memberships = new Map<string, number>();

    for (const region of view.regions) {
      for (const packageId of region.packageIds) {
        memberships.set(packageId, (memberships.get(packageId) ?? 0) + 1);
      }
    }

    for (const packageId of Object.keys(view.packages).sort()) {
      const count = memberships.get(packageId) ?? 0;

      if (count === 0) {
        context.report({ messageId: 'missing', values: { packageId } });
      } else if (count > 1) {
        context.report({ messageId: 'multiple', values: { packageId } });
      }
    }
  },
};

export const projectOwnershipConflictRule: TypedValidatorRegistration<
  'projects',
  ProjectValidationView,
  undefined,
  'conflict'
> = {
  descriptor: noOptionsDescriptor({
    category: 'ownership',
    description: 'Unique ownership domains reject conflicting candidates.',
    documentation: 'https://docs.senao.me/docs-islands/limina/concepts',
    id: 'projects/ownership-conflict',
    inputKind: 'projects',
    messages: {
      conflict: {
        text: '{kind} ownership for {fileId} has candidates: {candidates}.',
        title: 'Ownership conflict',
      },
    },
  }),
  validate(view, context) {
    for (const conflict of view.ownershipConflicts) {
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
  },
};

export const importEvidenceIntegrityRule: TypedValidatorRegistration<
  'import-facts',
  ImportFactsValidationView,
  undefined,
  'missing-evidence'
> = {
  descriptor: noOptionsDescriptor({
    category: 'dependency',
    description: 'Every import occurrence has stable evidence identity.',
    documentation:
      'https://docs.senao.me/docs-islands/limina/import-resolution-to-declaration-build-graph',
    id: 'imports/evidence-integrity',
    inputKind: 'import-facts',
    messages: {
      'missing-evidence': {
        text: 'Import {specifier} in {fileId} has no evidence identity.',
        title: 'Import evidence is incomplete',
      },
    },
  }),
  validate(view, context) {
    for (const occurrence of view.occurrences) {
      if (occurrence.evidenceId.length > 0) continue;
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
  },
};

export const sourceDependencyResolutionRule: TypedValidatorRegistration<
  'source-dependencies',
  SourceDependencyValidationView,
  undefined,
  'unresolved'
> = {
  descriptor: noOptionsDescriptor({
    category: 'dependency',
    description: 'Governed source dependencies must have classified targets.',
    documentation:
      'https://docs.senao.me/docs-islands/limina/import-resolution-to-declaration-build-graph',
    id: 'source-dependencies/unresolved-target',
    inputKind: 'source-dependencies',
    messages: {
      unresolved: {
        text: '{projectId} imports unresolved specifier {specifier}.',
        title: 'Source dependency is unresolved',
      },
    },
  }),
  validate(view, context) {
    for (const edge of view.edges) {
      if (edge.target.kind !== 'unresolved') continue;
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
  },
};

export const declarationCycleRule: TypedValidatorRegistration<
  'declaration-build',
  DeclarationBuildValidationView,
  undefined,
  'cycle'
> = {
  descriptor: noOptionsDescriptor({
    category: 'build',
    description: 'Declaration build references must be acyclic.',
    documentation:
      'https://docs.senao.me/docs-islands/limina/why-import-is-not-references',
    id: 'declaration-build/cycle',
    inputKind: 'declaration-build',
    messages: {
      cycle: {
        text: 'Declaration build cycle: {projects}.',
        title: 'Declaration build contains a cycle',
      },
    },
  }),
  validate(view, context) {
    for (const component of view.stronglyConnectedComponents) {
      if (component.length < 2) continue;
      context.report({
        messageId: 'cycle',
        values: { projects: component.join(' -> ') },
      });
    }
  },
};

export const outputBuildSelfEdgeRule: TypedValidatorRegistration<
  'output-build',
  OutputBuildValidationView,
  undefined,
  'self-edge'
> = {
  descriptor: noOptionsDescriptor({
    category: 'build',
    description: 'Output-build dependencies cannot point to the same package.',
    documentation: 'https://docs.senao.me/docs-islands/limina/workflows',
    id: 'output-build/self-edge',
    inputKind: 'output-build',
    messages: {
      'self-edge': {
        text: 'Package {packageId} contains a self-referential output edge.',
        title: 'Output build edge is self-referential',
      },
    },
  }),
  validate(view, context) {
    for (const edge of view.edges) {
      if (edge.fromPackageId !== edge.toPackageId) continue;
      context.report({
        messageId: 'self-edge',
        values: { packageId: edge.fromPackageId },
      });
    }
  },
};

export const packageArtifactAccessRule: TypedValidatorRegistration<
  'package-artifacts',
  PackageArtifactValidationView,
  undefined,
  'denied-export'
> = {
  descriptor: noOptionsDescriptor({
    category: 'architecture',
    description: 'Package artifact edges use accessible public exports.',
    documentation:
      'https://docs.senao.me/docs-islands/limina/monorepo-constraints',
    id: 'package-artifacts/public-export',
    inputKind: 'package-artifacts',
    messages: {
      'denied-export': {
        text: 'Package {packageId} subpath {subpath} is not publicly accessible.',
        title: 'Package export access denied',
      },
    },
  }),
  validate(view, context) {
    for (const edge of view.edges) {
      if (!edge.selectedSubpath) continue;
      const targetPackage = view.packages[edge.toPackageId];
      const selectedExport = targetPackage?.exports.find(
        (entry) => entry.subpath === edge.selectedSubpath,
      );

      if (!selectedExport || selectedExport.access === 'allowed') continue;
      context.report({
        messageId: 'denied-export',
        values: {
          packageId: edge.toPackageId,
          subpath: edge.selectedSubpath,
        },
      });
    }
  },
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
