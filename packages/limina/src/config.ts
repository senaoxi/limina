import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
       * Executable name, for example `pnpm`, `tsc`, or `vue-tsc`.
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
  | 'package:check'
  | 'proof:check'
  | 'release:check'
  | 'source:check';

export type BuiltinCheckerPreset = 'svelte-check' | 'tsc' | 'vue-tsc';

export type CheckerPreset = BuiltinCheckerPreset;

export type CheckerExecutionKind = 'build' | 'typecheck';

/**
 * Checker capability for one source module family.
 */
export interface CheckerConfig {
  /**
   * Built-in checker preset, such as `tsc`, `vue-tsc`, or `svelte-check`.
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
 * Source boundary that must be covered by checker entries or allowlist proof.
 */
export interface SourceBoundaryConfig {
  /**
   * Glob patterns for source files that need proof coverage.
   *
   * When omitted, Limina derives the source boundary from configured checker
   * extensions and then applies `exclude`.
   */
  include?: string[];
  /**
   * Glob patterns or directory shorthands to omit from proof coverage.
   *
   * @default: [
   *   "node_modules",
   *   "dist",
   *   ".git",
   *   ".tsbuild",
   *   "coverage",
   *   "**\/tsconfig*.json",
   *   "**\/package.json",
   *   ".prettierrc.json",
   *   ".markdownlint.json",
   *   "vercel.json",
   * ]
   */
  exclude?: string[];
}

/**
 * Shared project facts used by graph, paths, proof, and related checks.
 */
export interface SharedLiminaConfig {
  /**
   * Checker capabilities shared by graph, proof, paths, and tsc tasks.
   */
  checkers?: Record<string, CheckerConfig>;
  /**
   * Source file boundary used by coverage proof.
   */
  source?: SourceBoundaryConfig;
}

/**
 * Options for generated TypeScript `paths` compatibility files.
 */
export interface PathsConfig {
  /**
   * Directory names treated as build artifacts when mapping package exports
   * back to source files.
   */
  artifactDirectories?: string[];
  /**
   * Export condition priority when resolving package exports.
   *
   * Put more specific conditions earlier when your package exports use several
   * entries such as `types`, `import`, `node`, or `default`.
   */
  conditionPriority?: string[];
  /**
   * File name used for generated path mapping configs.
   *
   * @default "tsconfig.dts.paths.generated.json"
   */
  generatedFileName?: string;
  /**
   * Header marker written into generated files.
   *
   * Limina uses this to know which files it is allowed to refresh.
   */
  generatedFileMarker?: string;
  /**
   * Source extensions tried when replacing artifact exports with source files.
   */
  sourceExtensions?: string[];
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
 * Package-level graph governance rule keyed by a label declared in
 * `tsconfig*.dts.json`.
 */
export interface GraphRule {
  /**
   * Denied graph boundaries and workspace package dependencies.
   */
  deny?: GraphRuleDenyConfig;
}

/**
 * TypeScript project graph policy.
 */
export interface GraphConfig {
  /**
   * Label-based package and build-boundary access rules.
   *
   * A `tsconfig*.dts.json` can opt into one rule by declaring
   * `"limina": "<label>"`.
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
export interface PackagePublintCheckConfig {
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
export interface PackageAttwCheckConfig {
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
  publint?: PackagePublintCheckConfig;
  /**
   * Are The Types Wrong settings for this package output.
   */
  attw?: PackageAttwCheckConfig;
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
   * Options for generating TypeScript source `paths` compatibility files.
   */
  paths?: PathsConfig;
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
}

/**
 * CLI command currently loading the config.
 */
export type LiminaCommand =
  | 'check'
  | 'graph'
  | 'package'
  | 'paths'
  | 'proof'
  | 'release'
  | 'source'
  | (string & {});

/**
 * Environment passed to function-style configs.
 */
export interface LiminaConfigEnv {
  /**
   * CLI command family, such as `check`, `graph`, or `paths`.
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

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

const checkerObjectSchema = z.looseObject({});

const checkerConfigShapeSchema = z.looseObject({
  entry: nonEmptyStringSchema,
  preset: nonEmptyStringSchema,
});

const liminaConfigShapeSchema = z.looseObject({
  config: z
    .looseObject({
      checkers: z.record(z.string(), checkerConfigShapeSchema).optional(),
    })
    .optional(),
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

  if (field === 'config.checkers') {
    return [
      'Invalid Limina checker config:',
      '  field: config.checkers',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: config.checkers must be an object keyed by checker name.',
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

function collectCheckerConfigProblems(config: LiminaConfig): string[] {
  const problems = collectLiminaConfigShapeProblems(config);

  if (!checkerObjectSchema.safeParse(config).success) {
    return problems;
  }

  const checkers = config.config?.checkers;

  if (checkers === undefined) {
    return problems;
  }

  if (!checkerObjectSchema.safeParse(checkers).success) {
    return problems;
  }

  for (const [checkerName, checker] of Object.entries(checkers)) {
    const field = `config.checkers.${checkerName}`;

    const checkerObjectResult = checkerObjectSchema.safeParse(checker);

    if (!checkerObjectResult.success) {
      continue;
    }

    const checkerRecord = checkerObjectResult.data;
    const preset = checkerRecord.preset;

    if (Object.hasOwn(checkerRecord, 'extensions')) {
      problems.push(
        [
          'Invalid Limina checker config:',
          `  field: ${field}.extensions`,
          `  value: ${formatUnknownValue(checkerRecord.extensions)}`,
          '  reason: checker extensions are fixed by built-in presets and cannot be configured.',
        ].join('\n'),
      );
    }

    if (Object.hasOwn(checkerRecord, 'routes')) {
      problems.push(
        [
          'Invalid Limina checker config:',
          `  field: ${field}.routes`,
          `  value: ${formatUnknownValue(checkerRecord.routes)}`,
          '  reason: checker routes are not supported; move routes.build to entry and migrate routes.typecheck targets to tsconfig*.dts.json leaves reachable from that entry with local companions.',
        ].join('\n'),
      );
    }

    if (typeof preset !== 'string' || preset.trim().length === 0) {
      continue;
    }

    const adapter = getCheckerAdapter(preset);

    if (!adapter) {
      problems.push(
        [
          'Unsupported Limina checker preset:',
          `  field: ${field}.preset`,
          `  value: ${formatUnknownValue(preset)}`,
          '  reason: configured checker entries require a built-in checker adapter.',
        ].join('\n'),
      );
      continue;
    }
  }

  return problems;
}

function collectReleaseConfigProblems(config: LiminaConfig): string[] {
  const problems: string[] = [];

  if (!checkerObjectSchema.safeParse(config).success) {
    return problems;
  }

  const release = config.release;

  if (release === undefined) {
    return problems;
  }

  if (!checkerObjectSchema.safeParse(release).success) {
    problems.push(
      [
        'Invalid Limina release config:',
        '  field: release',
        `  value: ${formatUnknownValue(release)}`,
        '  reason: release must be an object.',
      ].join('\n'),
    );
    return problems;
  }

  const contentHash = release.contentHash;

  if (contentHash === undefined) {
    return problems;
  }

  if (!checkerObjectSchema.safeParse(contentHash).success) {
    problems.push(
      [
        'Invalid Limina release config:',
        '  field: release.contentHash',
        `  value: ${formatUnknownValue(contentHash)}`,
        '  reason: release.contentHash must be an object.',
      ].join('\n'),
    );
    return problems;
  }

  const baselineTag = contentHash.baselineTag;

  if (
    baselineTag !== undefined &&
    typeof baselineTag !== 'function' &&
    (typeof baselineTag !== 'string' || baselineTag.trim().length === 0)
  ) {
    problems.push(
      [
        'Invalid Limina release config:',
        '  field: release.contentHash.baselineTag',
        `  value: ${formatUnknownValue(baselineTag)}`,
        '  reason: baselineTag must be a non-empty string or function.',
      ].join('\n'),
    );
  }

  const builtinIgnore = contentHash.builtinIgnore;

  if (builtinIgnore !== undefined && typeof builtinIgnore !== 'boolean') {
    problems.push(
      [
        'Invalid Limina release config:',
        '  field: release.contentHash.builtinIgnore',
        `  value: ${formatUnknownValue(builtinIgnore)}`,
        '  reason: builtinIgnore must be a boolean.',
      ].join('\n'),
    );
  }

  const ignore = contentHash.ignore;

  if (ignore === undefined || typeof ignore === 'function') {
    return problems;
  }

  if (!Array.isArray(ignore)) {
    problems.push(
      [
        'Invalid Limina release config:',
        '  field: release.contentHash.ignore',
        `  value: ${formatUnknownValue(ignore)}`,
        '  reason: ignore must be an array of non-empty strings or function.',
      ].join('\n'),
    );
    return problems;
  }

  for (const [index, pattern] of ignore.entries()) {
    if (typeof pattern === 'string' && pattern.trim().length > 0) {
      continue;
    }

    problems.push(
      [
        'Invalid Limina release config:',
        `  field: release.contentHash.ignore[${index}]`,
        `  value: ${formatUnknownValue(pattern)}`,
        '  reason: ignore patterns must be non-empty strings.',
      ].join('\n'),
    );
  }

  return problems;
}

export function validateLiminaConfig(config: LiminaConfig): void {
  const problems = [
    ...collectCheckerConfigProblems(config),
    ...collectReleaseConfigProblems(config),
  ];

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }
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
