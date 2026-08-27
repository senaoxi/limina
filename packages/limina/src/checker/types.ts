import type {
  BuildCheckerName,
  CheckerExecutionKind,
  CheckerPreset,
  ResolvedCheckerConfig,
} from '#config/runner';
import type ts from 'typescript';
import type {
  LiminaDependencyFailureKind,
  LiminaDependencyOwnership,
} from '../dependency-contract';
import type { VueProjectSemanticIdentity } from './vue-semantic-types';

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
  allowNoInputDiagnostics?: boolean;
  configPath: string;
  extensions?: string[];
  projectRootDir: string;
  generation?: number;
  virtualFiles?: ReadonlyMap<string, string>;
  vueSemanticIdentity?: VueProjectSemanticIdentity;
}

export interface CheckerConfigClosureEntry {
  contentHash: string;
  filePath: string;
}

export interface ParsedCheckerProjectConfig {
  configClosure: CheckerConfigClosureEntry[];
  extensions: string[];
  fileNames: string[];
  options: ts.CompilerOptions;
  vueSemanticIdentity?: VueProjectSemanticIdentity;
}

export interface CheckerProjectParseContext {
  checkerPresets: CheckerPreset[];
  extensions: string[];
  vueSemanticIdentity?: VueProjectSemanticIdentity;
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
  tsModule?: typeof ts;
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
  dependencies: CheckerDependencies;
  parseProjectConfig: (
    options: CheckerProjectConfigParseOptions,
  ) => ParsedCheckerProjectConfig;
  name: BuildCheckerName;
  resolveModuleName: (options: CheckerModuleResolveOptions) => string | null;
  sourceGraph: boolean;
}

export interface CheckerDependencies {
  externalCheckerPackages: string[];
  liminaRuntimePackages: string[];
}

export type CheckerDependencyCategory =
  | 'checker-binary'
  | 'checker-runtime'
  | 'external-checker'
  | 'limina-runtime';

export interface CheckerDependencyRequirement {
  category: CheckerDependencyCategory;
  packageName: string;
}

export interface MissingCheckerPeerDependency {
  checkerNames: string[];
  failureKind: LiminaDependencyFailureKind;
  installedVersion?: string;
  ownership: LiminaDependencyOwnership;
  packageName: string;
  reason?: string;
  resolutionScope: string;
  supportedRange?: string;
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
