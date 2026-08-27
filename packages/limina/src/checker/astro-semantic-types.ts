import type semver from 'semver';
import type ts from 'typescript';

export interface AstroSemanticVersionTuple {
  astro: string;
  check: string;
  compiler: string;
  languageCore: string;
  languageServer: string;
  leafTypeScript: string;
  typeScript: string;
  volarKit: string;
  volarTypeScript: string;
}

export type AstroSemanticAdapter =
  | {
      family: 'astro-7-check-0.9';
      kind: 'supported';
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

export interface AstroSemanticToolchainPaths {
  astro: string;
  check: string;
  compiler: string;
  languageCore: string;
  languageServer: string;
  leafTypeScript: string;
  typeScript: string;
  volarKit: string;
  volarTypeScript: string;
  vscodeUri: string;
}

export interface AstroUri {
  readonly fsPath: string;
  readonly path: string;
  toString(): string;
}

export interface AstroVirtualCode {
  readonly id?: string;
  readonly snapshot: ts.IScriptSnapshot;
}

export interface AstroServiceScript {
  readonly code: AstroVirtualCode;
  readonly extension?: string;
  readonly fileName?: string;
  readonly scriptKind?: ts.ScriptKind;
}

export interface AstroLanguagePlugin {
  createVirtualCode?(
    id: AstroUri,
    languageId: string,
    snapshot: ts.IScriptSnapshot,
  ): AstroVirtualCode | undefined;
  getLanguageId?(id: AstroUri): string | undefined;
  readonly typescript?: {
    readonly extraFileExtensions?: readonly ts.FileExtensionInfo[];
    getExtraServiceScripts?(
      fileName: string,
      root: AstroVirtualCode,
    ): readonly AstroServiceScript[];
    getServiceScript(root: AstroVirtualCode): AstroServiceScript | undefined;
  };
}

export interface AstroSourceScript {
  readonly generated?: {
    readonly languagePlugin: AstroLanguagePlugin;
    readonly root: AstroVirtualCode;
  };
  readonly snapshot: ts.IScriptSnapshot;
}

export interface AstroMapper {
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

export interface AstroLanguage {
  readonly maps: {
    get(code: AstroVirtualCode, source: AstroSourceScript): AstroMapper;
  };
  readonly plugins: readonly AstroLanguagePlugin[];
  readonly scripts: {
    delete(id: AstroUri): void;
    get(
      id: AstroUri,
      includeFsFiles?: boolean,
      shouldRegister?: boolean,
    ): AstroSourceScript | undefined;
    set(
      id: AstroUri,
      snapshot: ts.IScriptSnapshot,
      languageId?: string,
    ): AstroSourceScript | undefined;
  };
}

export interface AstroLanguageCoreRuntime {
  createLanguage(
    plugins: AstroLanguagePlugin[],
    scriptRegistry: Map<AstroUri, AstroSourceScript>,
    sync: (
      id: AstroUri,
      includeFsFiles: boolean,
      shouldRegister: boolean,
    ) => void,
  ): AstroLanguage;
  forEachEmbeddedCode(root: AstroVirtualCode): Iterable<AstroVirtualCode>;
}

export interface AstroLanguageServerCoreRuntime {
  addAstroTypes(
    astroInstall: {
      directory: string;
      version: semver.SemVer;
    },
    tsModule: typeof ts,
    host: ts.LanguageServiceHost,
  ): void;
  getAstroLanguagePlugin(): AstroLanguagePlugin;
}

export interface AstroFrameworkPluginRuntime {
  getLanguagePlugin(): AstroLanguagePlugin;
}

export interface AstroVolarTypeScriptRuntime {
  createLanguageServiceHost(
    tsModule: typeof ts,
    sys: typeof ts.sys,
    language: AstroLanguage,
    asScriptId: (fileName: string) => AstroUri,
    projectHost: {
      getCompilationSettings(): ts.CompilerOptions;
      getCurrentDirectory(): string;
      getProjectReferences(): readonly ts.ProjectReference[] | undefined;
      getProjectVersion(): string;
      getScriptFileNames(): string[];
    },
  ): {
    getExtraServiceScript?(fileName: string): AstroServiceScript | undefined;
    languageServiceHost: ts.LanguageServiceHost;
  };
}

export interface AstroVscodeUriRuntime {
  URI: {
    file(fileName: string): AstroUri;
  };
}

export interface AstroSemanticToolchain {
  adapter: AstroSemanticAdapter;
  astroCore: AstroLanguageServerCoreRuntime;
  astroInstall: {
    directory: string;
    version: semver.SemVer;
  };
  languageCore: AstroLanguageCoreRuntime;
  paths: AstroSemanticToolchainPaths;
  sveltePlugin: AstroFrameworkPluginRuntime;
  tsModule: typeof ts;
  versions: AstroSemanticVersionTuple;
  volarTypeScript: AstroVolarTypeScriptRuntime;
  vscodeUri: AstroVscodeUriRuntime;
  vuePlugin: AstroFrameworkPluginRuntime;
}

export interface AstroSemanticSeed {
  analysisGeneration: number;
  configPath: string;
  id: string;
  overlayGeneration: number;
  packageRootDir: string;
  projectFingerprint: string;
}

export interface AstroConfigClosureEntry {
  contentHash: string;
  filePath: string;
}

export interface AstroSemanticProjectSnapshot {
  checkerExtensions: readonly string[];
  compilerOptions: ts.CompilerOptions;
  configClosure: readonly AstroConfigClosureEntry[];
  fileNames: readonly string[];
  projectReferences: readonly ts.ProjectReference[] | undefined;
}

export interface AstroSemanticProjectSnapshotInput
  extends Omit<AstroSemanticProjectSnapshot, 'projectReferences'> {
  projectReferences:
    | readonly ts.ProjectReference[]
    | readonly string[]
    | undefined;
}

export interface AstroSemanticProject {
  seed: AstroSemanticSeed;
  readSnapshot(): AstroSemanticProjectSnapshotInput;
}

export interface AstroMaterializedProject {
  seed: AstroSemanticSeed;
  snapshot: AstroSemanticProjectSnapshot;
}
