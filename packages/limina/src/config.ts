import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'pathe';
import { z } from 'zod';
import {
  getCheckerAdapter,
  getResolvedCheckers,
  normalizeExtensions,
} from './checkers';
import { isPathInsideDirectory } from './utils/path';

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
       * The command runs from the inferred workspace root unless `cwd` is set.
       */
      command: string;
      /**
       * Working directory for this step, relative to the inferred workspace root.
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
  | 'graph:check'
  | 'nx:check'
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
   * Checker entry project used by both build and typecheck execution modes.
   */
  entry: string;
}

export interface ResolvedCheckerConfig {
  entry: string;
  extensions: string[];
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
   * Workspace-root-relative source module path.
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
   * Workspace-root-relative file or glob patterns that Knip should treat as
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
 * Explicit exception for a source module whose nearest bare tsconfig.json
 * cannot identify a unique ordinary typecheck owner.
 */
export interface SourceTsconfigOwnershipIgnoreEntry {
  /**
   * Named package owner from package.json.
   */
  owner: string;
  /**
   * Workspace-root-relative file or glob patterns inside the owner package.
   */
  files: string[];
  /**
   * Why these modules may skip nearest-tsconfig ownership enforcement.
   */
  reason: string;
}

/**
 * Nearest bare tsconfig ownership settings.
 */
export interface SourceTsconfigOwnershipConfig {
  /**
   * Package-owned source modules intentionally exempted from nearest bare
   * tsconfig ownership enforcement.
   */
  ignore?: SourceTsconfigOwnershipIgnoreEntry[];
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
 * Source-owned dependency usage check settings.
 */
export interface SourceCheckConfig {
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
   * Exceptions for source modules whose nearest bare tsconfig.json cannot
   * resolve a unique ordinary typecheck owner.
   */
  tsconfigOwnership?: SourceTsconfigOwnershipConfig;
}

/**
 * Global source boundary used by proof checks.
 */
export interface SourceBoundaryConfig {
  /**
   * Glob patterns for source files that Limina should govern.
   *
   * When omitted, Limina uses TypeScript/JSON source defaults and adds
   * framework extensions from configured checkers, such as `.vue` or
   * `.svelte`.
   */
  include?: string[];
  /**
   * Glob patterns or directory shorthands to omit from source governance.
   *
   * When omitted, Limina reads the workspace root `.gitignore` and combines it
   * with the built-in excludes below.
   *
   * @default: [
   *   "nx.json",
   *   "project.json",
   *   "tsconfig.json",
   *   "**\/tsconfig.*.json",
   *   "dist",
   *   ".nx",
   *   ".git",
   *   ".tsbuild",
   *   "coverage",
   *   "node_modules",
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
  checkers?: Record<string, CheckerConfig>;
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
   * Target `tsconfig*.dts.json` path, relative to the inferred workspace root.
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
   * Target `tsconfig*.dts.json` path, relative to the inferred workspace root.
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
   * Domain entry `tsconfig*.dts.json` path, relative to the inferred workspace root.
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
   * File path to allow, relative to the inferred workspace root.
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
   * Built package directory to scan, relative to the inferred workspace root.
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

/**
 * Limina user config.
 */
export interface LiminaConfig {
  /**
   * Enable strict workspace modeling rules.
   *
   * Strict mode keeps the existing command surface but makes graph, proof,
   * source, package, and release checks enforce the complete Limina workspace
   * model.
   *
   * @default false
   */
  strict?: boolean;
  /**
   * Shared project facts, such as checker entries and source boundary.
   */
  config?: SharedLiminaConfig;
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
  | 'nx'
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
   * Absolute workspace root inferred from `cwd` and its parent directories.
   */
  rootDir: string;
}

/**
 * Type helper for limina.config.mjs.
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

const checkerExtensionsConfigReason =
  'checker extensions are fixed by built-in presets and cannot be configured.';

const checkerRoutesConfigReason =
  'checker routes are not supported; move routes.build to entry and migrate routes.typecheck targets to tsconfig*.dts.json leaves reachable from that entry with local companions.';

const unsupportedCheckerPresetReason =
  'configured checker entries require a built-in checker adapter.';

const checkerConfigShapeSchema = z
  .looseObject({})
  .superRefine((checker, ctx) => {
    const preset = checker.preset;
    const entry = checker.entry;

    if (Object.hasOwn(checker, 'extensions')) {
      ctx.addIssue({
        code: 'custom',
        message: checkerExtensionsConfigReason,
        path: ['extensions'],
      });
    }

    if (Object.hasOwn(checker, 'routes')) {
      ctx.addIssue({
        code: 'custom',
        message: checkerRoutesConfigReason,
        path: ['routes'],
      });
    }

    if (typeof preset !== 'string' || preset.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'checker preset must be a non-empty string.',
        path: ['preset'],
      });
    } else if (!getCheckerAdapter(preset)) {
      ctx.addIssue({
        code: 'custom',
        message: unsupportedCheckerPresetReason,
        path: ['preset'],
      });
    }

    if (typeof entry !== 'string' || entry.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'checker entry must be a non-empty string path.',
        path: ['entry'],
      });
    }
  });

const sharedLiminaConfigShapeSchema = z
  .looseObject({
    checkers: z.record(z.string(), checkerConfigShapeSchema).optional(),
  })
  .superRefine((sharedConfig, ctx) => {
    const source = sharedConfig.source;

    if (source === null || source === undefined || typeof source !== 'object') {
      return;
    }

    const sourceRecord = source as Record<string, unknown>;

    if (Object.hasOwn(sourceRecord, 'tsconfigOwnership')) {
      ctx.addIssue({
        code: 'custom',
        message:
          'source.tsconfigOwnership belongs at the top-level source config, not under config.source.',
        path: ['source', 'tsconfigOwnership', 'ignore'],
      });
    }
  });

const releaseContentHashShapeSchema = z
  .looseObject({})
  .superRefine((contentHash, ctx) => {
    const baselineTag = contentHash.baselineTag;

    if (
      baselineTag !== undefined &&
      typeof baselineTag !== 'function' &&
      (typeof baselineTag !== 'string' || baselineTag.trim().length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'baselineTag must be a non-empty string or function.',
        path: ['baselineTag'],
      });
    }

    const builtinIgnore = contentHash.builtinIgnore;

    if (builtinIgnore !== undefined && typeof builtinIgnore !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        message: 'builtinIgnore must be a boolean.',
        path: ['builtinIgnore'],
      });
    }

    const ignore = contentHash.ignore;

    if (ignore === undefined || typeof ignore === 'function') {
      return;
    }

    if (!Array.isArray(ignore)) {
      ctx.addIssue({
        code: 'custom',
        message: 'ignore must be an array of non-empty strings or function.',
        path: ['ignore'],
      });
      return;
    }

    for (const [index, pattern] of ignore.entries()) {
      if (typeof pattern === 'string' && pattern.trim().length > 0) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'ignore patterns must be non-empty strings.',
        path: ['ignore', index],
      });
    }
  });

const releaseConfigShapeSchema = z.looseObject({
  contentHash: releaseContentHashShapeSchema.optional(),
});

const liminaConfigShapeSchema = z
  .looseObject({
    strict: z.boolean().optional(),
    config: sharedLiminaConfigShapeSchema.optional(),
    release: releaseConfigShapeSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if (!Object.hasOwn(config, 'paths')) {
      return;
    }

    ctx.addIssue({
      code: 'custom',
      message:
        'paths config has been removed; use graph/proof/source checks instead.',
      path: ['paths'],
    });
  });

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function formatZodPath(pathSegments: readonly PropertyKey[]): string {
  return pathSegments
    .map((segment) =>
      typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`,
    )
    .join('')
    .replace(/^\./u, '');
}

function getValueAtPath(
  value: unknown,
  pathSegments: readonly PropertyKey[],
): unknown {
  let current = value;

  for (const segment of pathSegments) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

function formatLiminaConfigShapeIssue(
  value: unknown,
  issue: z.core.$ZodIssue,
): string {
  const pathSegments = issue.path as PropertyKey[];
  const field = formatZodPath(pathSegments);

  if (pathSegments.length === 0) {
    return 'limina config must export or return an object.';
  }

  if (field === 'config') {
    return [
      'Invalid Limina config:',
      '  field: config',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: config must be an object.',
    ].join('\n');
  }

  if (field === 'strict') {
    return [
      'Invalid Limina config:',
      '  field: strict',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: strict must be a boolean.',
    ].join('\n');
  }

  if (field === 'paths') {
    return [
      'Invalid Limina paths config:',
      '  field: paths',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'config.checkers') {
    return [
      'Invalid Limina checker config:',
      '  field: config.checkers',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: config.checkers must be an object keyed by checker name.',
    ].join('\n');
  }

  if (field === 'config.source.tsconfigOwnership.ignore') {
    return [
      'Invalid Limina source config:',
      '  field: config.source.tsconfigOwnership.ignore',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (pathSegments[0] === 'config' && pathSegments[1] === 'checkers') {
    const checkerName = pathSegments[2];
    const checkerField = `config.checkers.${String(checkerName)}`;

    if (pathSegments.length === 3) {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        '  reason: checker entries must be objects.',
      ].join('\n');
    }

    if (pathSegments[3] === 'preset') {
      if (issue.message === unsupportedCheckerPresetReason) {
        return [
          'Unsupported Limina checker preset:',
          `  field: ${checkerField}.preset`,
          `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
          `  reason: ${issue.message}`,
        ].join('\n');
      }

      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.preset`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        '  reason: checker preset must be a non-empty string.',
      ].join('\n');
    }

    if (pathSegments[3] === 'entry') {
      return [
        'Invalid Limina checker entry config:',
        `  field: ${checkerField}.entry`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        '  reason: checker entry must be a non-empty string path.',
      ].join('\n');
    }

    if (pathSegments[3] === 'extensions') {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.extensions`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${issue.message}`,
      ].join('\n');
    }

    if (pathSegments[3] === 'routes') {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.routes`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${issue.message}`,
      ].join('\n');
    }
  }

  if (field === 'release') {
    return [
      'Invalid Limina release config:',
      '  field: release',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: release must be an object.',
    ].join('\n');
  }

  if (field === 'release.contentHash') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: release.contentHash must be an object.',
    ].join('\n');
  }

  if (field === 'release.contentHash.baselineTag') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.baselineTag',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: baselineTag must be a non-empty string or function.',
    ].join('\n');
  }

  if (field === 'release.contentHash.builtinIgnore') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.builtinIgnore',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: builtinIgnore must be a boolean.',
    ].join('\n');
  }

  if (field === 'release.contentHash.ignore') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.ignore',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: ignore must be an array of non-empty strings or function.',
    ].join('\n');
  }

  if (
    pathSegments[0] === 'release' &&
    pathSegments[1] === 'contentHash' &&
    pathSegments[2] === 'ignore'
  ) {
    return [
      'Invalid Limina release config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: ignore patterns must be non-empty strings.',
    ].join('\n');
  }

  return [
    'Invalid Limina config:',
    `  field: ${field}`,
    `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
    `  reason: ${issue.message}`,
  ].join('\n');
}

function collectLiminaConfigShapeProblems(value: unknown): string[] {
  const result = liminaConfigShapeSchema.safeParse(value);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) =>
    formatLiminaConfigShapeIssue(value, issue),
  );
}

export function validateLiminaConfig(config: LiminaConfig): void {
  const problems = collectLiminaConfigShapeProblems(config);

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }
}

export function isStrictConfig(config: Pick<LiminaConfig, 'strict'>): boolean {
  return config.strict === true;
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
   * Config file path, resolved from `cwd`. When omitted, Limina searches for
   * the nearest `limina.config.mjs` from `cwd` upward to the inferred pnpm
   * workspace root.
   *
   * @default nearest "limina.config.mjs" in `cwd` or workspace parents
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
    const candidatePath = path.join(currentDir, 'limina.config.mjs');

    if (existsSync(candidatePath)) {
      return candidatePath;
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

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedLiminaConfig> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = inferWorkspaceRoot(cwd);
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : findLiminaConfigPath(cwd, rootDir);

  if (configPath) {
    validateConfigPathInsideWorkspace(configPath, rootDir);
  }

  if (!configPath || !existsSync(configPath)) {
    throw new Error(
      options.configPath
        ? `Unable to find limina config at ${configPath}`
        : `Unable to find limina config. Searched for limina.config.mjs from ${cwd} up to the pnpm workspace root at ${rootDir}.`,
    );
  }

  const module = (await import(
    `${pathToFileURL(configPath).href}?t=${Date.now()}`
  )) as {
    default?: unknown;
  };
  const config = await resolveConfigExport(
    module.default,
    createConfigEnv(options),
  );

  return {
    ...config,
    configPath,
    rootDir,
  };
}
