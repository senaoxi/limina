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
}

interface ProjectDependencyBase {
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
      typeEvidence?: Exclude<
        TypeEvidence,
        { kind: 'missing' | 'unsupported-checker' }
      >;
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
  resolveWorkspaceTypeScriptExport?: (specifier: string) => string | null;
}

export interface ProjectDependencyCaches {
  pendingOwnershipEvidenceCache: Map<string, unknown>;
  projectDependencyCache: Map<string, ProjectDependencyCollection>;
  projectDependencyPreparationCache: Map<string, ProjectDependencyPreparation>;
  sourceEvidenceCache: Map<string, SourceEvidence>;
}

export interface ProjectDependencyProvider {
  collect(request: ProjectDependencyRequest): ProjectDependencyCollection;
}
