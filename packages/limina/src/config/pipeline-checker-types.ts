export type RuntimeEnvironment = 'browser' | 'node' | string;

export type BuiltinTaskName =
  | 'checker:build'
  | 'checker:typecheck'
  | 'graph:prepare'
  | 'graph:check'
  | 'package:check'
  | 'proof:check'
  | 'release:check'
  | 'source:check';

export type PipelineStep =
  | string
  | {
      args?: string[];
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      type: 'command';
    }
  | {
      name: BuiltinTaskName;
      type: 'task';
    };

export type BuiltinCheckerPreset =
  | 'svelte-check'
  | 'tsc'
  | 'tsgo'
  | 'vue-tsc'
  | 'vue-tsgo';

export type CheckerPreset = BuiltinCheckerPreset;
export type BuildCheckerPreset = Extract<
  BuiltinCheckerPreset,
  'tsc' | 'tsgo' | 'vue-tsc'
>;
export type CheckerExecutionKind = 'build' | 'typecheck';

export interface CheckerConfig {
  exclude?: string[];
  include: string[];
  preset: CheckerPreset;
}

export interface AutoCheckerConfig {
  exclude?: string[];
  mode: 'auto';
}

export type CheckerConfigMode =
  | AutoCheckerConfig
  | Record<string, CheckerConfig>;

export type VueImportParser = 'compiler-sfc' | 'heuristic';

export interface ImportAnalysisConfig {
  vue?: VueImportParser;
}

export interface ResolvedCheckerConfig {
  exclude: string[];
  extensions: string[];
  include: string[];
  name: string;
  preset: CheckerPreset;
}
