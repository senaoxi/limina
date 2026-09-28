import type ts from 'typescript';

export type VueSourceProfile =
  | 'vue-sfc'
  | 'vitepress-markdown'
  | 'petite-vue-html';

export type VueSemanticAdapterFamily = 'vue-tsc-2.2' | 'vue-tsc-3.2';

export interface VueSemanticVersionTuple {
  languageCore: string;
  typeScript: string;
  volarTypeScript: string;
  vueTsc: string;
}

export type VueSemanticAdapter =
  | {
      family: VueSemanticAdapterFamily;
      kind: 'supported';
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

export interface VolarVirtualCode {
  snapshot: ts.IScriptSnapshot;
}

interface VolarLanguagePlugin {
  typescript?: {
    getServiceScript(root: VolarVirtualCode):
      | {
          code: VolarVirtualCode;
          extension?: string;
          scriptKind?: ts.ScriptKind;
        }
      | undefined;
  };
}

export interface VolarSourceScript {
  generated?: {
    languagePlugin: VolarLanguagePlugin;
    root: VolarVirtualCode;
  };
  snapshot?: ts.IScriptSnapshot;
}

interface VolarMapper {
  toGeneratedRange(
    start: number,
    end: number,
    fallbackToAnyMatch: boolean,
  ): Iterable<readonly [number, number, unknown, unknown]>;
  toSourceRange(
    start: number,
    end: number,
    fallbackToAnyMatch: boolean,
  ): Iterable<readonly [number, number, unknown, unknown]>;
}

export interface VolarLanguage {
  maps: {
    get(code: VolarVirtualCode, source: VolarSourceScript): VolarMapper;
  };
  scripts: {
    delete(id: string): void;
    get(id: string, includeFsFiles?: boolean): VolarSourceScript | undefined;
    set(
      id: string,
      snapshot: ts.IScriptSnapshot,
      languageId?: string,
    ): VolarSourceScript | undefined;
  };
}

export interface VueLanguageRuntime {
  createLanguage(
    plugins: unknown[],
    scriptRegistry: Map<string, VolarSourceScript>,
    sync: (
      id: string,
      includeFsFiles: boolean,
      shouldRegister: boolean,
    ) => void,
  ): VolarLanguage;
  createParsedCommandLine(
    tsModule: typeof ts,
    host: typeof ts.sys,
    configFileName: string,
  ): {
    errors?: readonly ts.Diagnostic[];
    options: ts.CompilerOptions;
    projectReferences?: readonly ts.ProjectReference[];
    vueOptions: unknown;
  };
  createVueLanguagePlugin(
    tsModule: typeof ts,
    compilerOptions: ts.CompilerOptions,
    vueOptions: unknown,
    asFileName: (scriptId: string) => string,
  ): unknown;
  getAllExtensions(vueOptions: unknown): string[];
}

export type VueResolvedModule = ts.ResolvedModuleWithFailedLookupLocations;

export type VueLanguageServiceHost = ts.LanguageServiceHost;

export interface VolarTypeScriptRuntime {
  createLanguageServiceHost(
    tsModule: typeof ts,
    sys: typeof ts.sys,
    language: VolarLanguage,
    asScriptId: (fileName: string) => string,
    projectHost: {
      getCompilationSettings(): ts.CompilerOptions;
      getCurrentDirectory(): string;
      getProjectReferences(): readonly ts.ProjectReference[] | undefined;
      getProjectVersion(): string;
      getScriptFileNames(): string[];
    },
  ): {
    languageServiceHost: VueLanguageServiceHost;
  };
}

export interface VueSemanticToolchainPaths {
  languageCore: string;
  typeScript: string;
  volarTypeScript: string;
  vueTsc: string;
}

export interface VueSemanticToolchain {
  adapter: VueSemanticAdapter;
  languageCore: VueLanguageRuntime;
  paths: VueSemanticToolchainPaths;
  tsModule: typeof ts;
  versions: VueSemanticVersionTuple;
  volarTypeScript: VolarTypeScriptRuntime;
}

export interface VueConfigClosureEntry {
  contentHash: string;
  filePath: string;
}

export interface VueProjectSemanticIdentity {
  configClosure: readonly VueConfigClosureEntry[];
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  id: string;
  options: ts.CompilerOptions;
  overlayFingerprint: string;
  profilesByFileName: ReadonlyMap<string, VueSourceProfile>;
  projectReferences: readonly ts.ProjectReference[] | undefined;
  projectRootDir: string;
  toolchain: VueSemanticToolchain;
  virtualFiles: ReadonlyMap<string, string>;
  vueOptions: unknown;
}
