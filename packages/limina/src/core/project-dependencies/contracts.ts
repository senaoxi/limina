import type {
  AstroSemanticProject,
  VueProjectSemanticIdentity,
} from '#checkers';
import type {
  ImportAnalysisContext,
  ImportRecord,
} from '#core/import-analysis/runner';
import type ts from 'typescript';
import type { LockedSemanticAuthority } from '../build-graph/checker-ownership-types';
import type { PreparedDependencyFact } from '../framework-semantic/contracts';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { SvelteSemanticProject } from '../svelte-semantic/types';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  TypeScriptSemanticDependencyContext,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { SourceSyntaxFactsCache } from '../typescript-semantic/syntax-cache';

import type {
  DeclarationReferenceRequirement,
  NativeDependencyFact,
} from '../typescript-semantic/dependency-fact';

export interface ProjectSemanticContext {
  astroSemanticProject?: AstroSemanticProject;
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  packageRootByFileName: ReadonlyMap<string, string>;
  packageRootDir: string;
  references: readonly ts.ProjectReference[];
  resolverConfigPath: string;
  semanticAuthority: LockedSemanticAuthority;
  svelteSemanticProject?: SvelteSemanticProject;
  vueSemanticIdentity?: VueProjectSemanticIdentity;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

interface ProjectDependencyBase {
  nativeFact?: NativeDependencyFact;
  referenceRequirement: DeclarationReferenceRequirement | null;
  importRecord: ImportRecord;
  resolutionMode: string;
  resolvedFilePath: string;
  semanticSpecifier: string;
  targetKind: 'declaration' | 'source';
  typeEvidence: TypeEvidence;
}

export interface DirectSourceDependency extends ProjectDependencyBase {
  provenance: 'direct-source';
}

export interface MappedSourceDependency extends ProjectDependencyBase {
  framework: 'astro' | 'svelte' | 'vue';
  provenance: 'strict-source-map';
}

export type ProjectDependency = DirectSourceDependency | MappedSourceDependency;

export type ProjectDependencyObservation =
  | {
      importRecord: ImportRecord;
      kind: 'missing';
      typeEvidence?: Extract<TypeEvidence, { kind: 'missing' }>;
    }
  | {
      importRecord: ImportRecord;
      kind: 'resource';
      typeEvidence?: Extract<TypeEvidence, { kind: 'checker-source' }>;
    }
  | {
      // The checker provides types through an ambient module declaration and
      // requires no compiler relation. This proves nothing about a runtime
      // resource; the complete specifier was never reinterpreted as a path.
      importRecord: ImportRecord;
      kind: 'semantic-only';
      typeEvidence: Extract<TypeEvidence, { kind: 'ambient' }>;
    }
  | {
      generatedFilePath: string;
      kind: 'unmapped-generated';
      semanticSpecifier: string;
    };

export type ProjectDependencyFailureStage =
  | 'dependency-enumeration'
  | 'generated-script-materialization'
  | 'module-resolution'
  | 'project-materialization'
  | 'resolution-host'
  | 'source-map-ambiguity'
  | 'source-map-mismatch'
  | 'toolchain-compatibility'
  | 'toolchain-resolution';

export interface ProjectDependencyFailure {
  configPath: string;
  framework: 'astro' | 'svelte' | 'typescript' | 'vue';
  identity: string;
  importRecord?: ImportRecord;
  reason: string;
  stage: ProjectDependencyFailureStage;
}

export interface ProjectDependencyCollection {
  dependencies: ProjectDependency[];
  failures: ProjectDependencyFailure[];
  observations: ProjectDependencyObservation[];
}

export interface ProjectDependencyPreparation {
  directSourceRecords: ImportRecord[];
  facts: PreparedDependencyFact[];
  failures: ProjectDependencyFailure[];
  observations: ProjectDependencyObservation[];
  ready: boolean;
}

export interface SourceEvidence {
  diagnostics: string[];
  filePath: string;
  records: ImportRecord[];
}

export interface ProjectDependencyRequest {
  caches?: ProjectDependencyCaches;
  context: ProjectSemanticContext;
  importAnalysis: ImportAnalysisContext;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  projectSemanticCacheIdentity?: string;
  resolveWorkspaceTypeScriptExport?: (specifier: string) => string | null;
  typeScriptSemanticContext?: TypeScriptSemanticDependencyContext;
  workspaceTypeScriptExportCacheIdentity?: string;
}

export interface ProjectDependencyCaches {
  readonly syntaxFacts?: SourceSyntaxFactsCache;
  pendingOwnershipEvidenceCache: Map<string, unknown>;
  projectDependencyCache: Map<string, ProjectDependencyCollection>;
  projectDependencyPreparationCache: Map<string, ProjectDependencyPreparation>;
  sourceEvidenceCache: Map<string, SourceEvidence>;
  typeScriptSemanticFactsCache: Map<
    string,
    TypeScriptSemanticDependencyContext
  >;
}

export interface ProjectDependencyProvider {
  collect(request: ProjectDependencyRequest): ProjectDependencyCollection;
}
