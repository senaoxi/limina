import type { RuntimeEnvironment } from './pipeline-checker-types';

export type PackageCheckTool = 'attw' | 'boundary' | 'publint';
export type PackageCheckToolSelection = PackageCheckTool | 'all';
export type PackageAttwProfile = 'esm-only' | 'node16' | 'strict';
export type PackagePublintLevel = 'error' | 'suggestion' | 'warning';
export type PackageAttwLevel = 'error' | 'warn';
export type PackageAttwIgnoreRule =
  | 'cjs-only-exports-default'
  | 'cjs-resolves-to-esm'
  | 'fallback-condition'
  | 'false-cjs'
  | 'false-esm'
  | 'false-export-default'
  | 'internal-resolution-error'
  | 'missing-export-equals'
  | 'named-exports'
  | 'no-resolution'
  | 'unexpected-module-syntax'
  | 'untyped-resolution'
  | (string & {});

export interface PackagePublintCheckConfig {
  level?: PackagePublintLevel;
  strict?: boolean;
}

export interface PackageAttwCheckConfig {
  entrypoints?: string[];
  entrypointsLegacy?: boolean;
  excludeEntrypoints?: (string | RegExp)[];
  ignoreRules?: PackageAttwIgnoreRule[];
  includeEntrypoints?: string[];
  level?: PackageAttwLevel;
  profile?: PackageAttwProfile;
}

export interface PackageBoundaryCheckConfig {
  environment?:
    | RuntimeEnvironment
    | ((relativeFilePath: string) => RuntimeEnvironment);
  ignoredExternalPackages?: string[];
}

export interface PackageEntry {
  attw?: boolean | PackageAttwCheckConfig;
  boundary?: PackageBoundaryCheckConfig;
  checks?: PackageCheckTool[];
  name: string;
  outDir: string;
  publint?: boolean | PackagePublintCheckConfig;
}

export interface PackageConfig {
  entries?: PackageEntry[];
}
