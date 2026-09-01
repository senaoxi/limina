import type {
  AstroSemanticProject,
  CheckerProjectParseContext,
  ResolvedCheckerModuleName,
  VueSourceProfile,
} from '#checkers';
import type { ResolverFactory } from 'oxc-resolver';
import type ts from 'typescript';
import type { AstroSemanticContextManager } from '../astro-semantic/context';
import type {
  FrameworkSemanticDependencyPreparation,
  FrameworkSemanticEvidence,
  FrameworkSemanticFailure,
} from '../framework-semantic/contracts';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { SvelteSemanticContextManager } from '../svelte-semantic/context';
import type { SvelteSemanticProject } from '../svelte-semantic/types';
import type { TypeScriptSemanticContext } from '../typescript-semantic';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import type { ImportRuntimeResolutionEvidence } from './evidence';
import type { ImportRecord } from './records';
import type { SemanticEligibility } from './semantic-eligibility';

export interface ModuleResolutionPair {
  oxc: string | null;
  semanticEvidence?: FrameworkSemanticEvidence;
  semanticFailure?: FrameworkSemanticFailure;
  typescript: ResolvedCheckerModuleName | null;
}

export interface CanonicalImportResolutionEvidence {
  eligibility: SemanticEligibility;
  oxcResolvedFilePath: string | null;
  runtimeEvidence: ImportRuntimeResolutionEvidence;
  semanticEvidence?: FrameworkSemanticEvidence;
  semanticFailure?: FrameworkSemanticFailure;
  typeScriptResolution: ResolvedCheckerModuleName | null;
}

export interface ImportResolveContextFields
  extends Pick<
    CheckerProjectParseContext,
    'checkerPresets' | 'extensions' | 'vueSemanticIdentity'
  > {
  astroSemanticProject?: AstroSemanticProject;
  configPath?: string;
  resolverConfigPath?: string;
  semanticFamily?: 'astro' | 'svelte' | 'typescript' | 'vue';
  svelteSemanticProject?: SvelteSemanticProject;
  typeScriptSemanticContext?: TypeScriptSemanticContext;
}

export type ImportResolveContextInput = ImportResolveContextFields | string[];

export type ImportResolutionArguments = [
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  contextOrExtensions?: ImportResolveContextInput,
];

export type ImportRecordResolutionArguments = [
  importRecord: ImportRecord,
  containingFile: string,
  options: ts.CompilerOptions,
  contextOrExtensions?: ImportResolveContextInput,
];

export type StandaloneInternalImportArguments = [
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  contextOrExtensions?: ImportResolveContextInput,
  analysisContext?: ImportAnalysisContext,
];

export interface ImportAnalysisContext {
  clearOxcResolverCaches?: () => void;
  collectImportsFromFile: (
    filePath: string,
    packageRootDir: string,
    sourceProfile?: VueSourceProfile,
  ) => ImportRecord[];
  dispose?: () => void;
  prepareCheckerSemanticDependencies: (options: {
    context: ImportResolveContextFields;
    filePath: string;
    managedOutputLookup?: ManagedOutputDeclarationLookup;
  }) => FrameworkSemanticDependencyPreparation;
  resolveCheckerImportEvidence: (
    ...args: ImportRecordResolutionArguments
  ) => CanonicalImportResolutionEvidence;
  resolveInternalImport: (...args: ImportResolutionArguments) => string | null;
  resolveImportEvidence: (
    ...args: ImportRecordResolutionArguments
  ) => CanonicalImportResolutionEvidence;
  resolveOxcImport: (...args: ImportResolutionArguments) => string | null;
  resolveModulePair: (
    ...args: ImportResolutionArguments
  ) => ModuleResolutionPair;
  resolveTypeScriptImport: (
    ...args: ImportResolutionArguments
  ) => ResolvedCheckerModuleName | null;
}

export interface CreateImportAnalysisContextOptions {
  astroSemanticContexts?: AstroSemanticContextManager;
  metrics?: ImportAnalysisMetricsRecorder;
  projectRootDir?: string;
  svelteSemanticContexts?: SvelteSemanticContextManager;
  vueSemanticContexts?: VueSemanticContextManager;
}

export interface ImportAnalysisMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'astro-candidate-count'
      | 'astro-context-dispose'
      | 'astro-context-materialize'
      | 'astro-context-reuse'
      | 'astro-semantic-cache-hit'
      | 'astro-semantic-cache-miss'
      | 'astro-semantic-failure'
      | 'astro-semantic-host-resolution'
      | 'import-resolution-cache-hit'
      | 'import-resolution-cache-miss'
      | 'internal-import-resolution'
      | 'module-resolution-index-hit'
      | 'module-resolution-index-miss'
      | 'module-resolution-request'
      | 'oxc-resolution'
      | 'oxc-resolver-factory-create'
      | 'oxc-resolver-factory-hit'
      | 'provider-cache-hit'
      | 'provider-cache-miss'
      | 'source-parse'
      | 'source-read'
      | 'typescript-module-resolution-cache-hit'
      | 'typescript-module-resolution-cache-miss'
      | 'typescript-resolution';
    readonly provider?: string;
  }): void;
}

export interface OxcResolverProfileIdentity {
  readonly conditionNames: readonly string[];
  readonly configPath: string;
  readonly extensions: readonly string[];
  readonly id: string;
  readonly packageJsonExportsAndImports: boolean;
  readonly preserveSymlinks: boolean;
}

export type ResolvedImportContext = CheckerProjectParseContext & {
  astroSemanticProject?: AstroSemanticProject;
  configPath?: string;
  resolverConfigPath?: string;
  semanticFamily?: 'astro' | 'svelte' | 'typescript' | 'vue';
  svelteSemanticProject?: SvelteSemanticProject;
  typeScriptSemanticContext?: TypeScriptSemanticContext;
};

export interface LazyModuleResolutionRecord {
  hasInternalImportResult: boolean;
  hasOxcResult: boolean;
  hasTypeScriptResult: boolean;
  internalImportResult: string | null;
  oxcResult: string | null;
  typeScriptResult: ResolvedCheckerModuleName | null;
}

export interface NormalizedModuleResolutionRequest {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: ResolvedImportContext;
  record: LazyModuleResolutionRecord;
  resolverIdentity: number;
  specifier: string;
}

export interface ImportAnalysisCaches {
  importsCache: Map<string, ImportRecord[]>;
  importsPromiseCache: Map<string, Promise<ImportRecord[]>>;
  canonicalResolutionIndex: Map<string, CanonicalImportResolutionEvidence>;
  checkerResolutionIndex: Map<string, CanonicalImportResolutionEvidence>;
  moduleResolutionIndex: Map<string, LazyModuleResolutionRecord>;
  moduleResolverIdentityCache: Map<string, number>;
  nextModuleResolverIdentity: number;
  resolverCache: Map<string, ResolverFactory>;
  sourceTextCache: Map<string, string>;
  typeScriptModuleResolutionCache: Map<string, ts.ModuleResolutionCache>;
}
