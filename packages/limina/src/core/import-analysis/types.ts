import type {
  CheckerProjectParseContext,
  ResolvedCheckerModuleName,
} from '#checkers';
import type { VueImportParser } from '#config/runner';
import type { ResolverFactory } from 'oxc-resolver';
import type ts from 'typescript';
import type { ImportRecord } from './records';

export interface ModuleResolutionPair {
  oxc: string | null;
  typescript: ResolvedCheckerModuleName | null;
}

export interface ImportResolveContextFields
  extends Pick<CheckerProjectParseContext, 'checkerPresets' | 'extensions'> {
  configPath?: string;
  resolverConfigPath?: string;
}

export type ImportResolveContextInput = ImportResolveContextFields | string[];

export type ImportResolutionArguments = [
  specifier: string,
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
  collectImportsFromFile: (filePath: string, rootDir: string) => ImportRecord[];
  resolveInternalImport: (...args: ImportResolutionArguments) => string | null;
  resolveOxcImport: (...args: ImportResolutionArguments) => string | null;
  resolveModulePair: (
    ...args: ImportResolutionArguments
  ) => ModuleResolutionPair;
  resolveTypeScriptImport: (
    ...args: ImportResolutionArguments
  ) => ResolvedCheckerModuleName | null;
}

export interface CreateImportAnalysisContextOptions {
  metrics?: ImportAnalysisMetricsRecorder;
  projectRootDir?: string;
  vueParser?: VueImportParser;
}

export interface ImportAnalysisMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
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
  configPath?: string;
  resolverConfigPath?: string;
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
  specifier: string;
}

export interface ImportAnalysisCaches {
  importsCache: Map<string, ImportRecord[]>;
  moduleResolutionIndex: Map<string, LazyModuleResolutionRecord>;
  moduleResolverIdentityCache: Map<string, number>;
  nextModuleResolverIdentity: number;
  resolverCache: Map<string, ResolverFactory>;
  sourceTextCache: Map<string, string>;
  typeScriptModuleResolutionCache: Map<string, ts.ModuleResolutionCache>;
}

export interface VueCompilerSfcBlock {
  attrs?: Record<string, string | true>;
  content: string;
  lang?: string;
  loc?: {
    start?: {
      line?: number;
      offset?: number;
    };
  };
  src?: string;
}

export interface VueCompilerSfc {
  parse: (
    source: string,
    options?: { filename?: string },
  ) => {
    descriptor: {
      script: VueCompilerSfcBlock | null;
      scriptSetup: VueCompilerSfcBlock | null;
    };
    errors: unknown[];
  };
}
