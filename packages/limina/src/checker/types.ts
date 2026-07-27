import type {
  BuiltinCheckerPreset,
  CheckerExecutionKind,
  CheckerPreset,
  ResolvedCheckerConfig,
} from '#config/runner';
import type ts from 'typescript';

export interface CheckerCommandTarget {
  args: string[];
  command: string;
  label: string;
}

export interface CheckerCommandTargetOptions {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
  watch?: boolean;
}

export interface CheckerProjectConfigParseOptions {
  configPath: string;
  extensions?: string[];
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}

export interface ParsedCheckerProjectConfig {
  extensions: string[];
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface CheckerProjectParseContext {
  checkerPresets: CheckerPreset[];
  extensions: string[];
}

export interface CheckerModuleResolutionMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'typescript-module-resolution-cache-hit'
      | 'typescript-module-resolution-cache-miss'
      | 'typescript-resolution';
    readonly provider?: string;
  }): void;
}

export interface CheckerModuleResolveOptions {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  extensions: string[];
  metrics?: CheckerModuleResolutionMetricsRecorder;
  moduleResolutionCache?: ts.ModuleResolutionCache;
  specifier: string;
}

export interface ResolvedCheckerModuleName {
  isExternalLibraryImport: boolean;
  resolvedBy: 'checker-source' | 'typescript';
  resolvedFileName: string;
}

export interface CheckerAdapter {
  createCommandTarget: (
    options: CheckerCommandTargetOptions,
  ) => CheckerCommandTarget;
  extensions: (options: CheckerProjectConfigParseOptions) => string[];
  execution: CheckerExecutionKind;
  emitProjection: 'typescript' | 'vue-bounded';
  packageNames: string[];
  parseProjectConfig: (
    options: CheckerProjectConfigParseOptions,
  ) => ParsedCheckerProjectConfig;
  preset: BuiltinCheckerPreset;
  resolveModuleName: (options: CheckerModuleResolveOptions) => string | null;
  sourceGraph: boolean;
}

export interface MissingCheckerPeerDependency {
  checkerNames: string[];
  packageName: string;
  reason?: string;
}

export type CheckerPackageResolver = (options: {
  packageName: string;
  projectRootDir: string;
}) => string | undefined;

export interface VueLanguageCore {
  createParsedCommandLine: (
    tsModule: typeof ts,
    host: typeof ts.sys,
    configFileName: string,
  ) => {
    errors?: readonly ts.Diagnostic[];
    vueOptions?: unknown;
  };
  getAllExtensions: (vueOptions: unknown) => string[];
}

export type CheckerBuildEngine =
  | 'tsc'
  | 'tsgo'
  | 'vue-tsc'
  | 'typecheck-only'
  | 'unknown';

export type CheckerCapabilityFamily =
  | 'typescript-native'
  | 'vue'
  | 'svelte'
  | 'unknown';
