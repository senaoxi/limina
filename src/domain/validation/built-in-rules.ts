import {
  validateDeclarationCycles,
  validateImportEvidenceIntegrity,
  validateOutputBuildSelfEdges,
  validatePackageArtifactAccess,
  validateProjectOwnershipConflicts,
  validateSourceDependencyResolution,
  validateWorkspaceRegionMembership,
} from './built-in-rule-helpers';
import type { TypedValidatorRegistration } from './contracts';
import { createNoOptionsDescriptor } from './descriptors';
import type {
  DeclarationBuildValidationView,
  ImportFactsValidationView,
  OutputBuildValidationView,
  PackageArtifactValidationView,
  ProjectValidationView,
  SourceDependencyValidationView,
  WorkspaceValidationView,
} from './views';

export const workspaceRegionMembershipRule: TypedValidatorRegistration<
  'workspace',
  WorkspaceValidationView,
  undefined,
  'missing' | 'multiple'
> = {
  descriptor: createNoOptionsDescriptor({
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
  validate: validateWorkspaceRegionMembership,
};

export const projectOwnershipConflictRule: TypedValidatorRegistration<
  'projects',
  ProjectValidationView,
  undefined,
  'conflict'
> = {
  descriptor: createNoOptionsDescriptor({
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
  validate: validateProjectOwnershipConflicts,
};

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
  validate: validateImportEvidenceIntegrity,
};

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
  validate: validateSourceDependencyResolution,
};

export const declarationCycleRule: TypedValidatorRegistration<
  'declaration-build',
  DeclarationBuildValidationView,
  undefined,
  'cycle'
> = {
  descriptor: createNoOptionsDescriptor({
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
  validate: validateDeclarationCycles,
};

export const outputBuildSelfEdgeRule: TypedValidatorRegistration<
  'output-build',
  OutputBuildValidationView,
  undefined,
  'self-edge'
> = {
  descriptor: createNoOptionsDescriptor({
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
  validate: validateOutputBuildSelfEdges,
};

export const packageArtifactAccessRule: TypedValidatorRegistration<
  'package-artifacts',
  PackageArtifactValidationView,
  undefined,
  'denied-export'
> = {
  descriptor: createNoOptionsDescriptor({
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
