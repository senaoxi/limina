import type ts from 'typescript';
import type { TypeEvidenceProgramHandle } from './cache';

export interface VueTypeEvidenceVersionTuple {
  languageCore: string;
  typeScript: string;
  volarTypeScript: string;
  vueTsc: string;
}

export interface VolarVirtualCode {
  snapshot: ts.IScriptSnapshot;
}

interface VolarLanguagePlugin {
  typescript?: {
    getServiceScript(
      root: VolarVirtualCode,
    ): { code: VolarVirtualCode } | undefined;
  };
}

export interface VolarSourceScript {
  generated?: {
    languagePlugin: VolarLanguagePlugin;
    root: VolarVirtualCode;
  };
}

interface VolarMapper {
  toGeneratedRange(
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
    get(id: string): VolarSourceScript | undefined;
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
}

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
    languageServiceHost: ts.LanguageServiceHost;
  };
}

export type VueTypeEvidenceCapability =
  | {
      kind: 'supported';
      languageCore: VueLanguageRuntime;
      tsModule: typeof ts;
      versionTuple: VueTypeEvidenceVersionTuple;
      volarTypeScript: VolarTypeScriptRuntime;
    }
  | {
      kind: 'unsupported';
      reason: string;
      versionTuple?: VueTypeEvidenceVersionTuple;
    };

export type SupportedVueTypeEvidenceCapability = Extract<
  VueTypeEvidenceCapability,
  { kind: 'supported' }
>;

export interface VueProgramHandle extends TypeEvidenceProgramHandle {
  language: VolarLanguage;
  languageService: ts.LanguageService;
}
