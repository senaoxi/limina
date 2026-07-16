import { getResolvedCheckers, normalizeExtensions } from '#checkers';
import { validateLiminaConfig } from '#config/schema';
import { isPathInsideDirectory } from '#utils/path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'pathe';
import type * as tsxEsmApi from 'tsx/esm/api';
import type { ExecutionConfig } from '../execution/config';

export { validateLiminaConfig } from '#config/schema';

/**
 * Runtime label used by package boundary checks.
 *
 * Use `browser` for code that must stay free of Node.js runtime imports,
 * `node` for server-only output, or a custom string when a package has its own
 * environment naming.
 */
export type RuntimeEnvironment = 'browser' | 'node' | string;

/**
 * One step in a named Limina pipeline.
 *
 * A string can be either a built-in task such as `graph:check`, or a command
 * split on whitespace. Use the object form when you need args, cwd, or env to
 * be unambiguous.
 */
export type PipelineStep =
  | string
  | {
      /**
       * Arguments passed to the command.
       *
       * Prefer this over a single command string when an argument contains
       * spaces or when you want the config to be easy to review.
       */
      args?: string[];
      /**
       * Executable name, for example `pnpm`, `tsc`, `tsgo`, `vue-tsc`, or `vue-tsgo`.
       *
       * The command runs from config.rootDir unless `cwd` is set.
       */
      command: string;
      /**
       * Working directory for this step, relative to config.rootDir.
       */
      cwd?: string;
      /**
       * Extra environment variables for this step.
       *
       * Values are merged on top of `process.env`.
       */
      env?: Record<string, string>;
      /**
       * Marks this pipeline step as an external command.
       */
      type: 'command';
    }
  | {
      /**
       * Built-in Limina task to run.
       */
      name: BuiltinTaskName;
      /**
       * Marks this pipeline step as a built-in task.
       */
      type: 'task';
    };

/**
 * Built-in task names understood by Limina pipelines.
 */
export type BuiltinTaskName =
  | 'checker:build'
  | 'checker:typecheck'
  | 'graph:prepare'
  | 'graph:check'
  | 'package:check'
  | 'proof:check'
  | 'release:check'
  | 'source:check';

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

/**
 * Checker capability for one source module family.
 */
export interface CheckerConfig {
  /**
   * Built-in checker preset, such as `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, or `svelte-check`.
   */
  preset: CheckerPreset;
  /**
   * Source-level ordinary tsconfig selectors covered by this checker.
   */
  include: string[];
  /**
   * Optional source-level tsconfig exclusion patterns.
   */
  exclude?: string[];
}

export interface AutoCheckerConfig {
  /**
   * Enables automatic checker discovery from ordinary source tsconfig.json
   * scopes.
   */
  mode: 'auto';
  /**
   * Optional source-level tsconfig exclusion patterns used during automatic
   * checker discovery.
   */
  exclude?: string[];
}

export type CheckerConfigMode =
  | AutoCheckerConfig
  | Record<string, CheckerConfig>;

export function isAutoCheckerConfigMode(
  checkers: CheckerConfigMode | undefined,
): checkers is AutoCheckerConfig {
  return Boolean(checkers && checkers.mode === 'auto');
}

export type VueImportParser = 'compiler-sfc' | 'heuristic';

/**
 * Source import analysis settings shared by graph, proof, source, and checker
 * tasks.
 */
export interface ImportAnalysisConfig {
  /**
   * Parser used to extract imports from Vue SFC script blocks.
   *
   * @default 'heuristic'
   */
  vue?: VueImportParser;
}

export interface ResolvedCheckerConfig {
  exclude: string[];
  extensions: string[];
  include: string[];
  name: string;
  preset: CheckerPreset;
}

/**
 * Explicit exception for a declared workspace package dependency that is used
 * through generated code, runtime strings, or another path that Knip
 * dependency analysis cannot see.
 */
export interface SourceKnipIgnoredDependencyConfig {
  /**
   * Declared workspace dependency package name.
   */
  dep: string;
  /**
   * Why the dependency is safe to keep even when Knip cannot prove it is
   * reachable from package entries, binaries, or scripts.
   */
  reason: string;
}

/**
 * Explicit exception for a source module that is owned by a package but is
 * intentionally not reachable from Knip's package entry graph.
 */
export interface SourceKnipIgnoredFileConfig {
  /**
   * Source module path relative to config.rootDir. Parent-relative paths are
   * allowed for external activated packages.
   */
  file: string;
  /**
   * Why the source module is safe to keep even when Knip cannot prove it is
   * reachable from package entries, binaries, or scripts.
   */
  reason: string;
}

/**
 * Additional source module entries for Knip's source reachability graph.
 *
 * Default entries come from package exports, package binaries, package scripts,
 * and Knip-supported plugin entries. Packages without package.json#exports are
 * treated as application-style owners: Limina provides the full governed source
 * module set as the entry surface and skips unused-file coverage for that
 * package. Use this only for extra entry modules loaded by test runners, local
 * tools, or build steps that should not become package exports.
 */
export interface SourceKnipEntryConfig {
  /**
   * File or glob patterns relative to config.rootDir that Knip should treat as
   * additional entries for the keyed package.
   */
  files: string[];
  /**
   * Why these modules are legitimate entries even though they are not package
   * exports, binaries, scripts, or plugin-discovered entries.
   */
  reason: string;
}

/**
 * Package-level Knip source analysis config interpreted by Limina.
 */
export interface SourceKnipWorkspaceConfig {
  /**
   * Additional package-owned source modules Knip should treat as reachable
   * roots. Limina disables Knip's implicit index/main/cli entry guessing by
   * default; package manifest entries, scripts, plugin-discovered entries, and
   * Limina virtual entries remain enabled.
   */
  entry?: SourceKnipEntryConfig[];
  /**
   * Declared workspace dependencies intentionally not visible through Knip's
   * entry-reachable dependency graph.
   */
  ignoreDependencies?: SourceKnipIgnoredDependencyConfig[];
  /**
   * Package-owned source modules intentionally not visible through Knip's
   * entry-reachable file graph.
   */
  ignoreFiles?: SourceKnipIgnoredFileConfig[];
}

/**
 * Knip-backed source analysis config interpreted by Limina.
 */
export interface SourceKnipCheckConfig {
  /**
   * Package-specific Knip source analysis config keyed by workspace package
   * name, such as "@example/app". Unknown package names fail source checks.
   */
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}

/**
 * Bare package import authority settings interpreted by source checks.
 */
export interface SourceImportAuthorityConfig {
  /**
   * Workspace root dependency authority grants keyed by source owner identity.
   */
  allow?: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

export interface SourceImportAuthorityWorkspaceRootGrant {
  /**
   * Config-root-relative source globs where this grant applies.
   *
   * When omitted, the grant applies to all governed source modules owned by
   * this source owner.
   */
  include?: string[];
  /**
   * Package names or package-name globs whose dependency declarations may be
   * read from the workspace root package.json when this grant matches.
   */
  workspaceRootDependencies: string[];
  /**
   * Why this owner may use these workspace-root dependency declarations.
   */
  reason: string;
}

export interface SourceAmbientDeclarationConfig {
  /** Config-root-relative glob patterns filtering activated-island files. */
  include: string[];
  /**
   * Allow matched declaration files to be consumed by TypeScript projects
   * governed by more than one source owner. The declaration files retain one
   * ambient governance role.
   *
   * @default false
   */
  allowSharedAcrossOwners?: boolean;
  /**
   * Allow source files to consume matched declarations through
   * `/// <reference path="...">`. This does not authorize ordinary imports or
   * `/// <reference types>`.
   *
   * @default false
   */
  allowTripleSlashReferences?: boolean;
  /** Why this ambient declaration exception is required. */
  reason: string;
}

export interface SourceDeclarationsConfig {
  ambient?: SourceAmbientDeclarationConfig[];
}

/**
 * Source-owned dependency usage check settings.
 */
export interface SourceCheckConfig {
  /** Explicit governance for declaration-file roles. */
  declarations?: SourceDeclarationsConfig;
  /**
   * Knip-backed unused dependency and unused source module analysis.
   *
   * `true` or omitted uses Limina's generated default config, `false` skips
   * these Knip-backed checks, and an object configures Limina's semantic Knip
   * source rules by workspace package name.
   *
   * @default true
   */
  knip?: boolean | SourceKnipCheckConfig;
  /**
   * Bare package import authorization rules.
   */
  importAuthority?: SourceImportAuthorityConfig;
}

/**
 * Global source boundary used by proof checks.
 */
export interface SourceBoundaryConfig {
  /**
   * Glob patterns for source files that Limina should govern.
   *
   * When omitted, Limina uses TypeScript-neutral source defaults:
   * `**\/*.ts`, `**\/*.tsx`, `**\/*.d.ts`, `**\/*.cts`, `**\/*.d.cts`,
   * `**\/*.mts`, and `**\/*.d.mts`.
   *
   * When configured, these patterns replace the defaults. Include the exact
   * string `"..."` to expand the default source patterns at that position,
   * for example `["...", "**\/*.vue"]`.
   *
   * Checker extensions such as `.vue` and `.svelte` are not included by
   * default.
   */
  include?: string[];
  /**
   * Glob patterns or directory shorthands to omit from source governance.
   *
   * When omitted, Limina uses the default exclude bundle: `node_modules`,
   * `bower_components`, `jspm_packages`, paths corresponding to explicit
   * `liminaOptions.outputs.outDir` declarations in relevant source configs,
   * and the workspace root `.gitignore`.
   *
   * When configured, these patterns replace the default exclude bundle and the
   * root `.gitignore` is not used. Include the exact string `"..."` to expand
   * the default exclude bundle, including root `.gitignore`, at that position.
   * An explicit `exclude` array without `"..."` disables every default exclude
   * entry.
   *
   * @default: [
   *   "node_modules",
   *   "bower_components",
   *   "jspm_packages",
   *   "<explicit liminaOptions.outputs.outDir paths>",
   *   "<root .gitignore>",
   * ]
   */
  exclude?: string[];
}

/**
 * Shared project facts used by graph, proof, and related checks.
 */
export interface SharedLiminaConfig {
  /**
   * Checker capabilities shared by graph, proof, and tsc tasks.
   */
  checkers?: CheckerConfigMode;
  /**
   * Source import analysis behavior shared by graph, proof, and source checks.
   */
  imports?: ImportAnalysisConfig;
  /**
   * Global source file boundary used by proof checks.
   */
  source?: SourceBoundaryConfig;
}

/**
 * Declaration leaf boundary denied to projects with a matching Limina label.
 */
export interface GraphRuleRefDenyEntry {
  /**
   * Target source config path, relative to config.rootDir.
   */
  path: string;
  /**
   * Human-readable explanation shown when the rule fails.
   */
  reason: string;
}

/**
 * Declaration leaf boundary explicitly allowed for projects with a matching
 * Limina graph rule when static import analysis cannot prove the edge.
 */
export interface GraphRuleRefAllowEntry {
  /**
   * Target source config path, relative to config.rootDir.
   */
  path: string;
  /**
   * Human-readable explanation documenting why this extra reference is safe.
   */
  reason: string;
}

/**
 * Dependency denied to projects with a matching Limina label.
 */
export interface GraphRuleDepDenyEntry {
  /**
   * Target package root, package.json imports specifier, or Node builtin name.
   *
   * Examples: `@acme/internal`, `zod`, `#internal/*`, `fs`, `node:fs`,
   * or `node:*`.
   */
  name: string;
  /**
   * Human-readable explanation shown when the rule fails.
   */
  reason: string;
}

/**
 * Deny lists for a Limina graph label.
 */
export interface GraphRuleDenyConfig {
  /**
   * Declaration leaf boundaries that matching projects must not reference or import.
   */
  refs?: GraphRuleRefDenyEntry[];
  /**
   * Packages, package imports, and Node builtins that matching projects must
   * not reference or import.
   */
  deps?: GraphRuleDepDenyEntry[];
}

/**
 * Allow lists for a Limina graph label.
 */
export interface GraphRuleAllowConfig {
  /**
   * Extra declaration leaf boundaries that matching projects may keep even
   * when static import analysis cannot prove them.
   */
  refs?: GraphRuleRefAllowEntry[];
}

/**
 * Package-level graph governance rule keyed by a label declared in
 * `tsconfig*.dts.json`.
 */
export interface GraphRule {
  /**
   * Allowed graph boundaries that static analysis cannot prove.
   */
  allow?: GraphRuleAllowConfig;
  /**
   * Denied graph boundaries and workspace package dependencies.
   */
  deny?: GraphRuleDenyConfig;
}

/**
 * TypeScript project graph policy.
 */
export interface GraphConditionDomain {
  /**
   * Human-readable domain name used in graph check reports.
   */
  name: string;
  /**
   * Domain entry source config path, relative to config.rootDir.
   */
  entry: string;
  /**
   * Bundler/package condition names expected for this declaration reference tree.
   */
  customConditions: string[];
}

export interface GraphConfig {
  /**
   * Real declaration resolution domains whose project references should share
   * the configured custom conditions.
   */
  conditionDomains?: GraphConditionDomain[];
  /**
   * Label-based package and build-boundary access rules.
   *
   * A `tsconfig*.dts.json` can opt into one or more rules by declaring
   * `liminaOptions.graphRules`.
   */
  rules?: Record<string, GraphRule>;
}

/**
 * Explicit exception for a source file that is intentionally not covered by the
 * normal proof rules.
 */
export interface ProofAllowlistEntry {
  /**
   * Source file path to allow, relative to config.rootDir.
   */
  file: string;
  /**
   * Why this file is safe to exclude from normal proof coverage.
   */
  reason: string;
}

/**
 * Typecheck coverage proof settings.
 */
export interface ProofConfig {
  /**
   * Intentional file-level exceptions.
   */
  allowlist?: ProofAllowlistEntry[];
}

/**
 * Package check tools that can run against a built package output.
 */
export type PackageCheckTool = 'attw' | 'boundary' | 'publint';

/**
 * CLI package check tool selection.
 */
export type PackageCheckToolSelection = PackageCheckTool | 'all';

/**
 * Are The Types Wrong profile used for package type resolution checks.
 */
export type PackageAttwProfile = 'esm-only' | 'node16' | 'strict';

/**
 * publint package check settings.
 */
export type PackagePublintLevel = 'error' | 'suggestion' | 'warning';

export interface PackagePublintCheckConfig {
  /**
   * Minimum publint message level to report.
   */
  level?: PackagePublintLevel;
  /**
   * Whether publint should run in strict mode.
   *
   * @default true
   */
  strict?: boolean;
}

/**
 * Are The Types Wrong package check settings.
 */
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

export interface PackageAttwCheckConfig {
  /**
   * Exhaustive list of package entrypoints to check. The package root is ".".
   */
  entrypoints?: string[];
  /**
   * Whether ATTW should consider all published files as entrypoints when no
   * other entrypoints are detected or configured.
   */
  entrypointsLegacy?: boolean;
  /**
   * Entrypoints to exclude from checking.
   */
  excludeEntrypoints?: (string | RegExp)[];
  /**
   * Problem rule names to ignore.
   */
  ignoreRules?: PackageAttwIgnoreRule[];
  /**
   * Entrypoints to check in addition to automatically discovered ones.
   */
  includeEntrypoints?: string[];
  /**
   * Whether ATTW findings fail the package check or are logged as warnings.
   *
   * @default "error"
   */
  level?: PackageAttwLevel;
  /**
   * Problem profile to enforce.
   *
   * `esm-only` ignores CJS resolution failures for pure ESM packages.
   *
   * @default "esm-only"
   */
  profile?: PackageAttwProfile;
}

/**
 * Built package import boundary settings.
 */
export interface PackageBoundaryCheckConfig {
  /**
   * Runtime environment for each emitted file.
   *
   * Use a string when the whole package has one environment, or a function when
   * different files have different environments.
   */
  environment?:
    | RuntimeEnvironment
    | ((relativeFilePath: string) => RuntimeEnvironment);
  /**
   * External package imports that are intentionally allowed even when they are
   * not listed in the built package manifest.
   */
  ignoredExternalPackages?: string[];
}

/**
 * One published package output entry.
 */
export interface PackageEntry {
  /**
   * Package name used by CLI filters, reports, and cwd release matching.
   */
  name: string;
  /**
   * Built package directory to scan, relative to config.rootDir.
   */
  outDir: string;
  /**
   * Package check tools enabled for this entry.
   *
   * @default ["publint", "attw", "boundary"]
   */
  checks?: PackageCheckTool[];
  /**
   * publint settings for this package output.
   */
  publint?: boolean | PackagePublintCheckConfig;
  /**
   * Are The Types Wrong settings for this package output.
   */
  attw?: boolean | PackageAttwCheckConfig;
  /**
   * Built package import boundary settings.
   */
  boundary?: PackageBoundaryCheckConfig;
}

/**
 * Published package settings.
 */
export interface PackageConfig {
  /**
   * Built package outputs to check.
   */
  entries?: PackageEntry[];
}

export interface ReleaseContentHashConfigArgs {
  /**
   * Package currently being release-checked.
   */
  importerName: string;
  /**
   * Workspace dependency package being compared against npm.
   */
  dependencyName: string;
}

/**
 * Release dependency artifact content hash settings.
 */
export interface ReleaseContentHashConfig {
  /**
   * npm dist-tag used as the online baseline for dependency package output.
   *
   * @default "latest"
   */
  baselineTag?: string | ((args: ReleaseContentHashConfigArgs) => string);
  /**
   * Use Limina's built-in dependency artifact ignore set as a fallback when
   * `ignore` is omitted or returns `undefined`.
   *
   * @default false
   */
  builtinIgnore?: boolean;
  /**
   * Additional package-relative glob patterns ignored by dependency artifact
   * content hashes.
   */
  ignore?:
    | string[]
    | ((args: ReleaseContentHashConfigArgs) => string[] | undefined);
}

/**
 * Release check settings.
 */
export interface ReleaseConfig {
  /**
   * Dependency artifact content hash comparison settings.
   */
  contentHash?: ReleaseContentHashConfig;
}

export type RegionExcludeKind = 'package-scope' | 'workspace-package';

/** A governance root excluded from the current Limina run. */
export interface RegionExcludeConfig {
  /**
   * The kind of governance root excluded by this rule.
   */
  kind: RegionExcludeKind;
  /**
   * Workspace-root-relative glob patterns matched against candidate root
   * directories.
   */
  include: string[];
  /**
   * Why the matched governance roots are outside the current Limina run.
   */
  reason: string;
}

/**
 * Pnpm workspace region boundary settings.
 */
export interface RegionsConfig {
  /**
   * Continue governance through eligible nested package scopes that have no
   * package name and are not claimed by a discovered pnpm workspace.
   *
   * Nested pnpm workspaces remain hard boundaries.
   *
   * @default false
   */
  extendNestedPackageScopes?: boolean;
  /**
   * Governance units or boundary roots intentionally excluded from the
   * current region.
   *
   * @default []
   */
  exclude?: RegionExcludeConfig[];
}

/**
 * Limina user config.
 */
export interface LiminaConfig {
  /**
   * Shared project facts, such as checker entries and source boundary.
   */
  config?: SharedLiminaConfig;
  /**
   * Bounded execution settings for task, checker, package, and release work.
   */
  execution?: ExecutionConfig;
  /**
   * TypeScript project graph and architecture rules.
   */
  graph?: GraphConfig;
  /**
   * Rules for checking built package outputs before publishing.
   */
  package?: PackageConfig;
  /**
   * Named command pipelines runnable through `limina check <name>`.
   */
  pipelines?: Record<string, PipelineStep[]>;
  /**
   * Rules that prove source files are covered by graph or checker entries.
   */
  proof?: ProofConfig;
  /**
   * Rules for release dependency artifact comparisons.
   */
  release?: ReleaseConfig;
  /**
   * Pnpm workspace region boundary configuration for a single Limina run.
   */
  regions?: RegionsConfig;
  /**
   * Rules for source-owned dependency usage checks.
   */
  source?: SourceCheckConfig;
}

/**
 * CLI command currently loading the config.
 */
export type LiminaCommand =
  | 'check'
  | 'graph'
  | 'package'
  | 'proof'
  | 'release'
  | 'source'
  | (string & {});

/**
 * Environment passed to function-style configs.
 */
export interface LiminaConfigEnv {
  /**
   * CLI command family, such as `check`, `graph`, or `package`.
   */
  command: LiminaCommand;
  /**
   * Mode passed through `--mode`.
   *
   * Defaults to `process.env.NODE_ENV`, then `default`.
   */
  mode: string;
}

export type LiminaConfigFnObject = (env: LiminaConfigEnv) => LiminaConfig;
export type LiminaConfigFnPromise = (
  env: LiminaConfigEnv,
) => Promise<LiminaConfig>;
export type LiminaConfigFn = (
  env: LiminaConfigEnv,
) => LiminaConfig | Promise<LiminaConfig>;

export type LiminaConfigExport =
  | LiminaConfig
  | Promise<LiminaConfig>
  | LiminaConfigFnObject
  | LiminaConfigFnPromise
  | LiminaConfigFn;

export interface ResolvedLiminaConfig extends LiminaConfig {
  /**
   * Absolute path to the loaded config file.
   */
  configPath: string;
  /**
   * Absolute pnpm workspace root associated with the loaded Limina config.
   */
  rootDir: string;
}

export type LiminaConfigLoader = 'native' | 'tsx';

export const DEFAULT_LIMINA_CONFIG_FILES = [
  'limina.config.mts',
  'limina.config.mjs',
  'limina.config.ts',
  'limina.config.js',
] as const;

/**
 * Type helper for Limina config files.
 *
 * Accepts a direct config object, a Promise, or a function that receives the
 * current {@link LiminaConfigEnv}.
 */
export function defineConfig(config: LiminaConfig): LiminaConfig;
export function defineConfig(
  config: Promise<LiminaConfig>,
): Promise<LiminaConfig>;
export function defineConfig(
  config: LiminaConfigFnObject,
): LiminaConfigFnObject;
export function defineConfig(
  config: LiminaConfigFnPromise,
): LiminaConfigFnPromise;
export function defineConfig(config: LiminaConfigFn): LiminaConfigFn;
export function defineConfig(config: LiminaConfigExport): LiminaConfigExport {
  return config;
}

export function getActiveCheckers(
  config: LiminaConfig,
): ResolvedCheckerConfig[] {
  validateLiminaConfig(config);
  return getResolvedCheckers(config);
}

export function getActiveCheckerExtensions(config: LiminaConfig): string[] {
  return normalizeExtensions(
    getActiveCheckers(config).flatMap((checker) => checker.extensions),
  );
}

function normalizeConfig(value: unknown): LiminaConfig {
  const config = value as LiminaConfig;

  validateLiminaConfig(config);

  return config;
}

export interface LoadConfigOptions {
  /**
   * Command family to expose to function-style configs.
   */
  command?: LiminaCommand;
  /**
   * Loader used to import the config module.
   *
   * @default "native"
   */
  configLoader?: LiminaConfigLoader;
  /**
   * Config file path, resolved from `cwd`. When omitted, Limina searches for
   * the nearest default Limina config file from `cwd` upward to the inferred
   * pnpm workspace root.
   *
   * When configured explicitly, the governed workspace root is inferred from
   * the config file directory, not from the command cwd.
   *
   * @default nearest default Limina config file in `cwd` or workspace parents
   */
  configPath?: string;
  /**
   * Directory used to resolve `configPath`.
   *
   * @default process.cwd()
   */
  cwd?: string;
  /**
   * Mode exposed to function-style configs.
   *
   * @default process.env.NODE_ENV ?? "default"
   */
  mode?: string;
}

function createConfigEnv(options: LoadConfigOptions): LiminaConfigEnv {
  return {
    command: options.command ?? 'check',
    mode: options.mode ?? process.env.NODE_ENV ?? 'default',
  };
}

function findPnpmWorkspaceRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function findLiminaConfigPath(
  startDir: string,
  rootDir: string,
): string | null {
  let currentDir = path.resolve(startDir);
  const workspaceRootDir = path.resolve(rootDir);

  while (isPathInsideDirectory(currentDir, workspaceRootDir)) {
    for (const fileName of DEFAULT_LIMINA_CONFIG_FILES) {
      const candidatePath = path.join(currentDir, fileName);

      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    if (currentDir === workspaceRootDir) {
      return null;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }

  return null;
}

function inferWorkspaceRoot(startDir: string): string {
  const rootDir = findPnpmWorkspaceRoot(startDir);

  if (!rootDir) {
    throw new Error(
      [
        `Unable to infer Limina workspace root from ${startDir}:`,
        'no pnpm-workspace.yaml was found in this directory or its parents.',
      ].join(' '),
    );
  }

  return rootDir;
}

function validateConfigPathInsideWorkspace(
  configPath: string,
  rootDir: string,
): void {
  if (isPathInsideDirectory(configPath, rootDir)) {
    return;
  }

  throw new Error(
    [
      `Unable to load Limina config at ${configPath}:`,
      `config file must be inside the governed pnpm workspace at ${rootDir}.`,
    ].join(' '),
  );
}

async function resolveConfigExport(
  configExport: unknown,
  configEnv: LiminaConfigEnv,
): Promise<LiminaConfig> {
  const config =
    typeof configExport === 'function'
      ? await (configExport as LiminaConfigFn)(configEnv)
      : await configExport;

  return normalizeConfig(config);
}

function hasSourceImportAuthorityWorkspaceRootGrants(
  config: LiminaConfig,
): boolean {
  const allow = config.source?.importAuthority?.allow;

  if (!allow) {
    return false;
  }

  return Boolean(
    Object.values(allow).some((grants) =>
      grants.some((grant) =>
        grant.workspaceRootDependencies.some(
          (packageName) => packageName.trim().length > 0,
        ),
      ),
    ),
  );
}

function validateRootPackageImportAuthorityConfig(
  config: LiminaConfig,
  rootDir: string,
): void {
  if (!hasSourceImportAuthorityWorkspaceRootGrants(config)) {
    return;
  }

  const rootPackageJsonPath = path.join(rootDir, 'package.json');

  if (existsSync(rootPackageJsonPath)) {
    return;
  }

  throw new Error(
    [
      'Invalid source import authority config:',
      '  field: source.importAuthority.allow',
      '  reason: workspaceRootDependencies grants require a workspace root package.json.',
      '  fix: create a workspace root package.json, or remove workspaceRootDependencies grants.',
    ].join('\n'),
  );
}

function resolveConfigLoader(configLoader: unknown): LiminaConfigLoader {
  if (configLoader === undefined || configLoader === 'native') {
    return 'native';
  }

  if (configLoader === 'tsx') {
    return 'tsx';
  }

  throw new Error(
    `Unsupported Limina config loader "${String(configLoader)}". Expected one of: native, tsx.`,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function shouldSuggestTsxLoader(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
    code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ||
    message.includes('Unknown file extension ".ts"') ||
    message.includes('Unknown file extension ".mts"') ||
    message.includes('Cannot find module') ||
    (typeof stack === 'string' &&
      stack.includes('node:internal/modules/esm/translators'))
  );
}

function unwrapModuleDefault(module: unknown): unknown {
  if (
    typeof module === 'object' &&
    module !== null &&
    'default' in module &&
    Object.prototype.toString.call(module) === '[object Module]'
  ) {
    return (module as { default: unknown }).default;
  }

  return module;
}

function unwrapTsxConfigExport(module: unknown): unknown {
  const value = unwrapModuleDefault(module);

  if (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    Object.prototype.toString.call(value) === '[object Object]' &&
    Object.keys(value).length === 1
  ) {
    return (value as { default: unknown }).default;
  }

  return value;
}

async function nativeImportConfig(configPath: string): Promise<unknown> {
  const url = pathToFileURL(configPath);
  url.searchParams.set('t', String(Date.now()));

  try {
    const module = (await import(url.href)) as {
      default?: unknown;
    };

    return unwrapModuleDefault(module);
  } catch (error) {
    if (shouldSuggestTsxLoader(error)) {
      throw new Error(
        [
          'Failed to load the Limina config file with the native loader.',
          'Try setting the --config-loader CLI flag to `tsx`.',
          '',
          getErrorMessage(error),
        ].join('\n'),
        { cause: error },
      );
    }

    throw error;
  }
}

async function tsxImportConfig(configPath: string): Promise<unknown> {
  let tsxApi: typeof tsxEsmApi;

  try {
    tsxApi = await import('tsx/esm/api');
  } catch (error) {
    throw new Error(
      [
        'Failed to load the Limina config file with the tsx loader.',
        'Please install `tsx` in the current workspace before using --config-loader tsx.',
      ].join('\n'),
      { cause: error },
    );
  }

  const module = (await tsxApi.tsImport(
    pathToFileURL(configPath).href,
    import.meta.url,
  )) as {
    default?: unknown;
  };

  return unwrapTsxConfigExport(module);
}

async function loadConfigModule(
  configPath: string,
  configLoader: unknown,
): Promise<unknown> {
  const loader = resolveConfigLoader(configLoader);

  return loader === 'native'
    ? nativeImportConfig(configPath)
    : tsxImportConfig(configPath);
}

function formatDefaultConfigFileList(): string {
  return DEFAULT_LIMINA_CONFIG_FILES.map((fileName) => `"${fileName}"`).join(
    ', ',
  );
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedLiminaConfig> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : undefined;
  const rootDir = configPath
    ? inferWorkspaceRoot(path.dirname(configPath))
    : inferWorkspaceRoot(cwd);
  const resolvedConfigPath = configPath ?? findLiminaConfigPath(cwd, rootDir);

  if (resolvedConfigPath) {
    validateConfigPathInsideWorkspace(resolvedConfigPath, rootDir);
  }

  if (!resolvedConfigPath || !existsSync(resolvedConfigPath)) {
    throw new Error(
      options.configPath
        ? `Unable to find limina config at ${resolvedConfigPath}`
        : `Unable to find limina config. Searched for ${formatDefaultConfigFileList()} from ${cwd} up to the pnpm workspace root at ${rootDir}.`,
    );
  }

  const config = await resolveConfigExport(
    await loadConfigModule(resolvedConfigPath, options.configLoader),
    createConfigEnv(options),
  );
  validateRootPackageImportAuthorityConfig(config, rootDir);

  return {
    ...config,
    configPath: resolvedConfigPath,
    rootDir,
  };
}
