import type {
  PackageAttwCheckConfig,
  PackageAttwIgnoreRule,
  PackageAttwProfile,
  PackageCheckTool,
  PackageCheckToolSelection,
  PackageEntry,
  PackagePublintCheckConfig,
  ResolvedLiminaConfig,
  RuntimeEnvironment,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import { getPackageRootSpecifier } from '#core/workspace/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import type {
  checkPackage,
  CheckPackageOptions,
  createPackageFromTarballData,
  Problem,
} from '@arethetypeswrong/core';
import { pack } from '@publint/pack';
import { init, parse } from 'es-module-lexer';
import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'pathe';
import type { publint } from 'publint';
import type { formatMessage } from 'publint/utils';
import type { LiminaWritableCheckIssueCode } from '../check-reporting/codes';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type {
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckRunCheckItemSummary,
} from '../check-reporting/snapshot';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import {
  createCheckItemStats,
  createSkippedCheckItemStats,
} from '../check-reporting/stats';
import { resolvePackageEntryConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import {
  formatMissingOptionalToolSkipMessage,
  isLiminaOptionalToolMissingError,
  LiminaOptionalToolMissingError,
} from '../execution/tools';
import type { LiminaFlowReporter } from '../flow';
import { formatErrorMessage, PackageLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import type { PackageEntrySelectionPlan } from './entry-selection';
import {
  collectBuiltPackageManifestProblems,
  collectSelfSpecifierMatchers,
  type DistPackageJson,
  findPackageImportTargets,
  isAllowedSelfSpecifier,
  type SelfSpecifierMatchers,
} from './manifest';

export type { DistPackageJson } from './manifest';

export {
  createPackageEntrySelectionPlan,
  type PackageEntrySelectionPlan,
} from './entry-selection';

export interface PublishedPackageBoundaryTarget {
  outDir: string;
  environment?:
    | RuntimeEnvironment
    | ((relativeFilePath: string) => RuntimeEnvironment);
  ignoredExternalPackages?: string[];
}

export interface PublishedPackageBoundaryViolation {
  environment: RuntimeEnvironment;
  filePath: string;
  message: string;
  specifier: string;
}

export interface PackedPackageTarball {
  cleanup: () => Promise<void>;
  tarball: Buffer;
  tarballPath: string;
}

export interface RunPackageCheckOptions {
  attwProfile?: PackageAttwProfile;
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  packageNames?: readonly string[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
  tool?: PackageCheckToolSelection;
}

interface PackageCheckEntryRunResult {
  checkedToolCount: number;
  durationMs: number;
  issues: LiminaCheckIssue[];
  label: string;
  passed: boolean;
  skippedToolCount: number;
}
type PackageToolCheckResult = 'failed' | 'passed' | 'skipped';
const ATTW_PROFILE_IGNORED_RESOLUTIONS: Record<PackageAttwProfile, string[]> = {
  strict: [],
  node16: ['node10'],
  'esm-only': ['node10', 'node16-cjs'],
};
const ATTW_PROBLEM_RULE_NAMES = {
  CJSOnlyExportsDefault: 'cjs-only-exports-default',
  CJSResolvesToESM: 'cjs-resolves-to-esm',
  FallbackCondition: 'fallback-condition',
  FalseCJS: 'false-cjs',
  FalseESM: 'false-esm',
  FalseExportDefault: 'false-export-default',
  InternalResolutionError: 'internal-resolution-error',
  MissingExportEquals: 'missing-export-equals',
  NamedExports: 'named-exports',
  NoResolution: 'no-resolution',
  UnexpectedModuleSyntax: 'unexpected-module-syntax',
  UntypedResolution: 'untyped-resolution',
} as const satisfies Record<string, PackageAttwIgnoreRule>;
const nodeBuiltinSpecifiers = new Set(
  builtinModules.flatMap((specifier) =>
    specifier.startsWith('node:')
      ? [specifier, specifier.slice('node:'.length)]
      : [specifier, `node:${specifier}`],
  ),
);

function createMissingPeerDependencyError(options: {
  command: string;
  error: unknown;
  packageName: string;
  toolName?: string;
}): Error {
  return new LiminaOptionalToolMissingError({
    command: options.command,
    error: options.error,
    packageName: options.packageName,
    toolName: options.toolName,
  });
}

function addPackageCheckIssue(options: {
  code: LiminaWritableCheckIssueCode;
  detailLines?: readonly string[];
  evidence?: readonly LiminaCheckIssueEvidence[];
  external?: LiminaCheckIssueExternal;
  filePath?: string;
  fix: string;
  fixSteps?: readonly string[];
  issueSink?: LiminaCheckIssue[];
  packageManifestPath?: string;
  packageName?: string;
  reason: string;
  rootDir: string;
  summary?: string;
  title: string;
  tool: PackageCheckTool | 'manifest';
  verifyCommands?: readonly string[];
}): void {
  options.issueSink?.push(
    createTaskFailureIssue({
      code: options.code,
      detailLines: options.detailLines,
      domain: 'package',
      evidence: options.evidence,
      external: options.external ?? {
        tool: options.tool,
      },
      filePath: options.filePath,
      fix: options.fix,
      fixSteps: options.fixSteps ?? [options.fix],
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      reason: options.reason,
      rootDir: options.rootDir,
      summary: options.summary,
      task: 'package:check',
      title: options.title,
      tool: options.tool,
      verifyCommands: options.verifyCommands ?? ['limina package check'],
    }),
  );
}

async function loadPublintPeer(): Promise<{
  formatMessage: typeof formatMessage;
  publint: typeof publint;
}> {
  try {
    const [publintModule, publintUtilsModule] = await Promise.all([
      import('publint'),
      import('publint/utils'),
    ]);

    return {
      formatMessage: publintUtilsModule.formatMessage,
      publint: publintModule.publint,
    };
  } catch (error) {
    throw createMissingPeerDependencyError({
      command: 'package check',
      error,
      packageName: 'publint',
    });
  }
}

async function loadAttwPeer(): Promise<{
  checkPackage: typeof checkPackage;
  createPackageFromTarballData: typeof createPackageFromTarballData;
}> {
  try {
    const attwModule = await import('@arethetypeswrong/core');

    return {
      checkPackage: attwModule.checkPackage,
      createPackageFromTarballData: attwModule.createPackageFromTarballData,
    };
  } catch (error) {
    throw createMissingPeerDependencyError({
      command: 'package check',
      error,
      packageName: '@arethetypeswrong/core',
      toolName: 'attw',
    });
  }
}

function isPackagePublintCheckConfig(
  value: PackageEntry['publint'],
): value is PackagePublintCheckConfig {
  return isPlainRecord(value);
}

function isPackageAttwCheckConfig(
  value: PackageEntry['attw'],
): value is PackageAttwCheckConfig {
  return isPlainRecord(value);
}

function getPackagePublintCheckConfig(
  entry: PackageEntry,
): PackagePublintCheckConfig {
  return isPackagePublintCheckConfig(entry.publint) ? entry.publint : {};
}

function getPackageAttwCheckConfig(
  entry: PackageEntry,
): PackageAttwCheckConfig {
  return isPackageAttwCheckConfig(entry.attw) ? entry.attw : {};
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('http:') ||
    specifier.startsWith('https:') ||
    specifier.startsWith('data:')
  );
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function normalizePublishedModulePath(relativeFilePath: string): string {
  return relativeFilePath.replaceAll('\\', '/');
}

function classifyRuntimeEnvironment(
  target: PublishedPackageBoundaryTarget,
  relativeFilePath: string,
): RuntimeEnvironment {
  if (typeof target.environment === 'function') {
    return target.environment(relativeFilePath);
  }

  if (target.environment) {
    return target.environment;
  }

  const normalizedPath = normalizePublishedModulePath(relativeFilePath);

  return normalizedPath.startsWith('node/') ||
    normalizedPath.startsWith('plugin/')
    ? 'node'
    : 'browser';
}

async function collectPublishedModuleFiles(
  directoryPath: string,
): Promise<string[]> {
  const entries = await readdir(directoryPath, {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectPublishedModuleFiles(absolutePath)));
      continue;
    }

    if (/\.[cm]?js$/u.test(entry.name)) {
      files.push(absolutePath);
    }
  }

  return files;
}

function validatePublishedSpecifier(options: {
  allowedExternalPackages: Set<string>;
  environment: RuntimeEnvironment;
  importsField: DistPackageJson['imports'];
  outDir: string;
  packageName: string;
  selfSpecifiers: SelfSpecifierMatchers;
  specifier: string;
}): string | null {
  const {
    allowedExternalPackages,
    environment,
    importsField,
    outDir,
    packageName,
    selfSpecifiers,
    specifier,
  } = options;

  if (specifier.startsWith('#')) {
    const match = findPackageImportTargets(importsField, specifier);

    if (!match) {
      return `package import "${specifier}" is not declared by output package.json imports`;
    }

    for (const target of match.targets) {
      if (target === null) {
        return `package import "${specifier}" is forbidden by the null target in output package.json imports key "${match.key}"`;
      }

      if (typeof target !== 'string' || target.trim().length === 0) {
        return `package import "${specifier}" has an invalid target in output package.json imports key "${match.key}"`;
      }

      if (target.startsWith('.')) {
        const absoluteTarget = normalizeAbsolutePath(
          path.resolve(outDir, target),
        );

        if (!isPathInsideDirectory(absoluteTarget, outDir)) {
          return `package import "${specifier}" target "${target}" escapes the published package root`;
        }

        if (!existsSync(absoluteTarget)) {
          return `package import "${specifier}" target "${target}" is not present in the published package`;
        }

        continue;
      }

      if (target.startsWith('#') || isRelativeOrAbsoluteSpecifier(target)) {
        return `package import "${specifier}" has unsupported target "${target}"`;
      }

      const targetProblem = validatePublishedSpecifier({
        ...options,
        importsField: undefined,
        specifier: target,
      });

      if (targetProblem) {
        return `package import "${specifier}" target "${target}" is invalid: ${targetProblem}`;
      }
    }

    return null;
  }

  if (isRelativeOrAbsoluteSpecifier(specifier)) {
    return null;
  }

  if (nodeBuiltinSpecifiers.has(specifier)) {
    if (environment === 'node') {
      return null;
    }

    return `browser/runtime output must not import Node builtin "${specifier}"`;
  }

  const packageRoot = getPackageRootSpecifier(specifier);

  if (packageRoot === packageName) {
    if (isAllowedSelfSpecifier(specifier, selfSpecifiers)) {
      return null;
    }

    return `self import "${specifier}" is not exposed by output package.json exports`;
  }

  if (allowedExternalPackages.has(packageRoot)) {
    return null;
  }

  return `"${specifier}" resolves to package "${packageRoot}" which is not listed in dependencies, peerDependencies, optionalDependencies, or self exports`;
}

function formatAttwProblem(problem: Problem): string {
  const resolutionKind =
    'resolutionKind' in problem
      ? ` [resolution: ${problem.resolutionKind}]`
      : '';
  const entrypoint =
    'entrypoint' in problem ? ` [entrypoint: ${problem.entrypoint}]` : '';

  switch (problem.kind) {
    case 'NoResolution': {
      return `No resolution${resolutionKind}${entrypoint}`;
    }
    case 'UntypedResolution': {
      return `Untyped resolution${resolutionKind}${entrypoint}`;
    }
    case 'FalseESM': {
      return `False ESM: ${problem.typesFileName} -> ${problem.implementationFileName}`;
    }
    case 'FalseCJS': {
      return `False CJS: ${problem.typesFileName} -> ${problem.implementationFileName}`;
    }
    case 'CJSResolvesToESM': {
      return `CJS resolves to ESM${resolutionKind}${entrypoint}`;
    }
    case 'FallbackCondition': {
      return `Fallback condition used${resolutionKind}${entrypoint}`;
    }
    case 'NamedExports': {
      return problem.isMissingAllNamed
        ? `Named exports missing: all named exports [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`
        : `Named exports missing: ${problem.missing.join(', ') || '(none)'} [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
    }
    case 'FalseExportDefault': {
      return `False export default [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
    }
    case 'MissingExportEquals': {
      return `Missing export equals [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
    }
    case 'InternalResolutionError': {
      return `Internal resolution error in ${problem.fileName} [option: ${problem.resolutionOption}] [module: ${problem.moduleSpecifier}]`;
    }
    case 'UnexpectedModuleSyntax': {
      return `Unexpected module syntax in ${problem.fileName}`;
    }
    case 'CJSOnlyExportsDefault': {
      return `CJS only exports default in ${problem.fileName}`;
    }
    default: {
      return `Unknown ATTW problem: ${JSON.stringify(problem)}`;
    }
  }
}

function getAttwProblemRuleName(problem: Problem): PackageAttwIgnoreRule {
  return (
    ATTW_PROBLEM_RULE_NAMES[
      problem.kind as keyof typeof ATTW_PROBLEM_RULE_NAMES
    ] ?? problem.kind
  );
}

function logPackageCheckPlan(options: {
  config: ResolvedLiminaConfig;
  cwd: string;
  plan: PackageEntrySelectionPlan;
}): void {
  PackageLogger.info(
    [
      'Package check plan:',
      `  config: ${toRelativePath(
        options.config.rootDir,
        options.config.configPath,
      )}`,
      `  cwd: ${toRelativePath(options.config.rootDir, options.cwd)}`,
      `  selection: ${options.plan.selectionReason}`,
      '  entries:',
      ...options.plan.entries.map((entry) =>
        [
          `    - ${entry.label}`,
          `      outDir: ${toRelativePath(options.config.rootDir, entry.outDir)}`,
          `      checks: ${
            entry.checks.length > 0 ? entry.checks.join(', ') : '(none)'
          }`,
        ].join('\n'),
      ),
    ].join('\n'),
  );
}

export async function packOutputTarball(
  outDir: string,
): Promise<PackedPackageTarball> {
  const destination = await mkdtemp(path.join(tmpdir(), '__LIMINA_PACKAGE__'));
  const tarballPath = await pack(outDir, {
    destination,
    ignoreScripts: true,
    packageManager: 'pnpm',
  });
  const tarball = await readFile(tarballPath);

  return {
    cleanup: async () => {
      await rm(destination, {
        force: true,
        recursive: true,
      }).catch(() => null);
    },
    tarball,
    tarballPath,
  };
}

export async function readDistPackageJson(options: {
  config?: ResolvedLiminaConfig;
  label?: string;
  packageJsonPath: string;
}): Promise<DistPackageJson> {
  if (!existsSync(options.packageJsonPath)) {
    throw new Error(
      `outDir package.json not found${
        options.label ? ` for ${options.label}` : ''
      } at ${
        options.config
          ? toRelativePath(options.config.rootDir, options.packageJsonPath)
          : options.packageJsonPath
      }. Run the package build first.`,
    );
  }

  return JSON.parse(
    await readFile(options.packageJsonPath, 'utf8'),
  ) as DistPackageJson;
}

async function runPublintCheck(options: {
  config: PackagePublintCheckConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  packageManifestPath: string;
  packageName?: string;
  rootDir: string;
  tarball: Buffer;
}): Promise<PackageToolCheckResult> {
  const task = options.flow?.start(`publint: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });

  const publintElapsed = createElapsedTimer();
  let publintPeer: Awaited<ReturnType<typeof loadPublintPeer>>;

  try {
    publintPeer = await loadPublintPeer();
  } catch (error) {
    if (!isLiminaOptionalToolMissingError(error)) {
      throw error;
    }

    const message = formatMissingOptionalToolSkipMessage(error.toolName);

    PackageLogger.warn(`${message}: ${options.label}`, publintElapsed());
    task?.skip(message);
    return 'skipped';
  }

  PackageLogger.info(`publint started: ${options.label}`);
  const { formatMessage, publint } = publintPeer;
  const { messages, pkg } = await publint({
    level: options.config.level,
    pack: { tarball: toArrayBuffer(options.tarball) },
    strict: options.config.strict ?? true,
  });

  if (messages.length === 0) {
    if (!options.flow?.interactive) {
      PackageLogger.success(
        `publint passed: ${options.label}`,
        publintElapsed(),
      );
    }

    task?.pass();
    return 'passed';
  }

  for (const message of messages) {
    const rendered = formatMessage(message, pkg) ?? message.code;

    addPackageCheckIssue({
      code: 'LIMINA_PACKAGE_PUBLINT',
      detailLines: [`[${options.label}] [publint] ${rendered}`],
      evidence: [{ label: 'publint', value: rendered }],
      external: {
        code: message.code,
        message: rendered,
        tool: 'publint',
      },
      fix: 'Inspect the publint message and adjust package exports, types, or published files.',
      fixSteps: [
        'Inspect the publint message for the affected export, type, or published file.',
        'Update the built package manifest or package output so publint resolves the package correctly.',
        'Rebuild the package output and rerun the package check.',
      ],
      issueSink: options.issueSink,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      reason: rendered,
      rootDir: options.rootDir,
      summary: rendered,
      title: 'Publint package issue',
      tool: 'publint',
    });

    if (message.type === 'error') {
      PackageLogger.error(`[${options.label}] [publint] ${rendered}`);
      continue;
    }
    if (message.type === 'warning') {
      PackageLogger.warn(`[${options.label}] [publint] ${rendered}`);
      continue;
    }

    PackageLogger.info(`[${options.label}] [publint] ${rendered}`);
  }

  PackageLogger.error(
    `publint found ${messages.length} issue(s): ${options.label}`,
    publintElapsed(),
  );
  task?.fail(`publint found ${messages.length} issue(s): ${options.label}`);
  return 'failed';
}

async function runAttwCheck(options: {
  config: PackageAttwCheckConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  packageManifestPath: string;
  packageName?: string;
  profile: PackageAttwProfile;
  rootDir: string;
  tarball: Buffer;
}): Promise<PackageToolCheckResult> {
  const task = options.flow?.start(`attw: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });

  const attwElapsed = createElapsedTimer();
  let attwPeer: Awaited<ReturnType<typeof loadAttwPeer>>;

  try {
    attwPeer = await loadAttwPeer();
  } catch (error) {
    if (!isLiminaOptionalToolMissingError(error)) {
      throw error;
    }

    const message = formatMissingOptionalToolSkipMessage(error.toolName);

    PackageLogger.warn(`${message}: ${options.label}`, attwElapsed());
    task?.skip(message);
    return 'skipped';
  }

  PackageLogger.info(
    `attw started: ${options.label} (profile: ${options.profile})`,
  );
  const { checkPackage, createPackageFromTarballData } = attwPeer;
  const pkg = createPackageFromTarballData(options.tarball);
  const checkOptions: CheckPackageOptions = {
    entrypoints: options.config.entrypoints,
    entrypointsLegacy: options.config.entrypointsLegacy,
    excludeEntrypoints: options.config.excludeEntrypoints,
    includeEntrypoints: options.config.includeEntrypoints,
  };
  const result = await checkPackage(pkg, checkOptions);

  if (!result.types) {
    addPackageCheckIssue({
      code: 'LIMINA_PACKAGE_ATTW',
      detailLines: [`[${options.label}] [attw] package has no types`],
      evidence: [{ label: 'attw', value: 'package has no types' }],
      external: {
        message: 'package has no types',
        tool: 'attw',
      },
      fix: 'Publish type declarations or adjust the package entry/type metadata.',
      issueSink: options.issueSink,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      reason: 'ATTW could not find package types.',
      rootDir: options.rootDir,
      summary: 'ATTW could not find package types.',
      title: 'ATTW package issue',
      tool: 'attw',
    });
    PackageLogger.error(`[${options.label}] [attw] package has no types`);
    PackageLogger.error(`attw failed: ${options.label}`, attwElapsed());
    task?.fail(`attw failed: ${options.label}`);
    return 'failed';
  }

  const ignoredResolutions = ATTW_PROFILE_IGNORED_RESOLUTIONS[options.profile];
  const ignoredRuleNames = new Set(options.config.ignoreRules);
  const problems = result.problems.filter((problem) => {
    if ('resolutionKind' in problem) {
      if (ignoredResolutions.includes(problem.resolutionKind)) {
        return false;
      }
    }

    return !ignoredRuleNames.has(getAttwProblemRuleName(problem));
  });

  if (problems.length === 0) {
    if (!options.flow?.interactive) {
      PackageLogger.success(`attw passed: ${options.label}`, attwElapsed());
    }

    task?.pass();
    return 'passed';
  }

  for (const problem of problems) {
    const message = `[${options.label}] [attw] ${formatAttwProblem(problem)}`;

    if (options.config.level !== 'warn') {
      addPackageCheckIssue({
        code: 'LIMINA_PACKAGE_ATTW',
        detailLines: [message],
        evidence: [{ label: 'attw', value: formatAttwProblem(problem) }],
        external: {
          code: getAttwProblemRuleName(problem),
          message: formatAttwProblem(problem),
          tool: 'attw',
        },
        fix: 'Inspect the ATTW message and adjust package exports/types for consumer resolution.',
        fixSteps: [
          'Inspect the ATTW message for the failing entrypoint and resolution mode.',
          'Update package exports, types, or emitted declaration files for that consumer resolution.',
          'Rebuild the package output and rerun the package check.',
        ],
        issueSink: options.issueSink,
        packageManifestPath: options.packageManifestPath,
        packageName: options.packageName,
        reason: formatAttwProblem(problem),
        rootDir: options.rootDir,
        summary: formatAttwProblem(problem),
        title: 'ATTW package issue',
        tool: 'attw',
      });
    }

    if (options.config.level === 'warn') {
      PackageLogger.warn(message);
    } else {
      PackageLogger.error(message);
    }
  }

  if (options.config.level === 'warn') {
    PackageLogger.warn(
      `attw found ${problems.length} problem(s): ${options.label}`,
      attwElapsed(),
    );
    task?.pass();
    return 'passed';
  }

  PackageLogger.error(
    `attw found ${problems.length} problem(s): ${options.label}`,
    attwElapsed(),
  );
  task?.fail(`attw found ${problems.length} problem(s): ${options.label}`);
  return 'failed';
}

async function runBoundaryCheck(
  target: PublishedPackageBoundaryTarget,
  label: string,
  options: {
    flow?: LiminaFlowReporter;
    flowDepth?: number;
    issueSink?: LiminaCheckIssue[];
    packageManifestPath: string;
    packageName?: string;
    rootDir: string;
  },
): Promise<boolean> {
  const task = options.flow?.start(`package boundary: ${label}`, {
    depth: options.flowDepth ?? 0,
  });

  PackageLogger.info(`package boundary started: ${label}`);
  const boundaryElapsed = createElapsedTimer();
  const violations = await auditPublishedPackageBoundaries(target);

  if (violations.length === 0) {
    if (!options.flow?.interactive) {
      PackageLogger.success(
        `package boundary passed: ${label}`,
        boundaryElapsed(),
      );
    }

    task?.pass();
    return true;
  }

  for (const violation of violations) {
    const structuredFilePath = path.resolve(target.outDir, violation.filePath);
    addPackageCheckIssue({
      code: 'LIMINA_PACKAGE_BOUNDARY',
      detailLines: [
        `[${label}] [boundary] ${violation.filePath} (${violation.environment}) imports "${violation.specifier}": ${violation.message}`,
      ],
      evidence: [
        {
          label: 'import',
          value: `${violation.filePath} imports "${violation.specifier}"`,
        },
        { label: 'environment', value: violation.environment },
      ],
      filePath: structuredFilePath,
      fix: 'Remove the import, change the package boundary config, or move the code to an environment that allows this dependency.',
      fixSteps: [
        'Remove the disallowed import from the published output.',
        'Move the code to an environment where the dependency is allowed, or adjust the package boundary config.',
        'Rebuild the package output and rerun the package check.',
      ],
      issueSink: options.issueSink,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      reason: violation.message,
      rootDir: options.rootDir,
      summary: `${violation.filePath} imports "${violation.specifier}" in ${violation.environment}.`,
      title: 'Published package boundary issue',
      tool: 'boundary',
    });
    PackageLogger.error(
      `[${label}] [boundary] ${violation.filePath} (${violation.environment}) imports "${violation.specifier}": ${violation.message}`,
    );
  }

  PackageLogger.error(
    `package boundary found ${violations.length} issue(s): ${label}`,
    boundaryElapsed(),
  );
  task?.fail(`package boundary found ${violations.length} issue(s): ${label}`);
  return false;
}

async function runPackageCheckEntry(options: {
  attwProfile?: PackageAttwProfile;
  checks: PackageCheckTool[];
  config: ResolvedLiminaConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  outDir: string;
  progressItem?: TaskProgressItem;
  rawEntry: PackageEntry;
}): Promise<{
  checkedToolCount: number;
  passed: boolean;
  skippedToolCount: number;
}> {
  const entry = {
    ...options.rawEntry,
    outDir: options.outDir,
  };
  const label = options.label;
  const outputPackageJsonPath = path.join(entry.outDir, 'package.json');
  const task = options.progressItem
    ? undefined
    : options.flow?.start(`package entry: ${label}`, {
        depth: options.flowDepth ?? 0,
      });

  let packedDist: PackedPackageTarball | undefined;

  try {
    const outputManifest = await readDistPackageJson({
      config: options.config,
      label,
      packageJsonPath: outputPackageJsonPath,
    });
    const packageName = outputManifest.name;
    const manifestProblems = collectBuiltPackageManifestProblems({
      label,
      manifest: outputManifest,
      packageJsonPath: toRelativePath(
        options.config.rootDir,
        outputPackageJsonPath,
      ),
    });

    const needsPackedTarball =
      options.checks.includes('publint') || options.checks.includes('attw');

    if (needsPackedTarball) {
      const packTask = options.flow?.start(`package tarball: ${label}`, {
        depth: (options.flowDepth ?? 0) + 1,
      });
      PackageLogger.info(`package tarball packing started: ${label}`);
      const packElapsed = createElapsedTimer();
      try {
        packedDist = await packOutputTarball(entry.outDir);
      } catch (error) {
        PackageLogger.error(
          `package tarball failed: ${label}: ${formatErrorMessage(error)}`,
          packElapsed(),
        );
        packTask?.fail(`package tarball failed: ${label}`, { error });
        throw error;
      }
      if (!options.flow?.interactive) {
        PackageLogger.success(
          `package tarball packed: ${label}`,
          packElapsed(),
        );
      }

      packTask?.pass();
    }

    let passed = manifestProblems.length === 0;
    let checkedToolCount = 0;
    let skippedToolCount = 0;
    const applyToolResult = (result: PackageToolCheckResult): void => {
      if (result === 'skipped') {
        skippedToolCount += 1;
        return;
      }

      checkedToolCount += 1;
      if (result === 'failed') {
        passed = false;
      }
    };

    for (const problem of manifestProblems) {
      addPackageCheckIssue({
        code: 'LIMINA_PACKAGE_MANIFEST_INVALID',
        detailLines: problem.split('\n'),
        evidence: [
          { label: 'manifest diagnostic', lines: problem.split('\n') },
        ],
        fix: 'Fix the built package manifest before publishing or checking the package output.',
        fixSteps: [
          'Fix the built package manifest field reported in the diagnostic.',
          'Rebuild the package output.',
          'Rerun the package check.',
        ],
        issueSink: options.issueSink,
        packageManifestPath: outputPackageJsonPath,
        packageName,
        reason: problem.split('\n')[0] ?? 'Built package manifest is invalid.',
        rootDir: options.config.rootDir,
        summary: problem.split('\n')[0] ?? 'Built package manifest is invalid.',
        title: 'Built package manifest issue',
        tool: 'manifest',
      });
      PackageLogger.error(problem);
    }

    if (options.checks.includes('publint')) {
      applyToolResult(
        await runPublintCheck({
          config: getPackagePublintCheckConfig(entry),
          flow: options.flow,
          flowDepth: (options.flowDepth ?? 0) + 1,
          issueSink: options.issueSink,
          label,
          packageManifestPath: outputPackageJsonPath,
          packageName,
          rootDir: options.config.rootDir,
          tarball: packedDist!.tarball,
        }),
      );
    }

    if (options.checks.includes('attw')) {
      const attwConfig = getPackageAttwCheckConfig(entry);

      applyToolResult(
        await runAttwCheck({
          config: attwConfig,
          flow: options.flow,
          flowDepth: (options.flowDepth ?? 0) + 1,
          issueSink: options.issueSink,
          label,
          packageManifestPath: outputPackageJsonPath,
          packageName,
          profile: options.attwProfile ?? attwConfig.profile ?? 'esm-only',
          rootDir: options.config.rootDir,
          tarball: packedDist!.tarball,
        }),
      );
    }

    if (options.checks.includes('boundary')) {
      applyToolResult(
        (await runBoundaryCheck(
          {
            ...entry.boundary,
            outDir: entry.outDir,
          },
          label,
          {
            flow: options.flow,
            flowDepth: (options.flowDepth ?? 0) + 1,
            issueSink: options.issueSink,
            packageManifestPath: outputPackageJsonPath,
            packageName,
            rootDir: options.config.rootDir,
          },
        ))
          ? 'passed'
          : 'failed',
      );
    }

    if (passed) {
      if (!options.flow?.interactive) {
        PackageLogger.success(`package checks passed: ${label}`);
      }

      task?.pass();
    } else {
      PackageLogger.error(`package checks failed: ${label}`);
      task?.fail(`package checks failed: ${label}`);
    }

    return {
      checkedToolCount,
      passed,
      skippedToolCount,
    };
  } catch (error) {
    PackageLogger.error(
      `package checks failed: ${label}: ${formatErrorMessage(error)}`,
    );
    task?.fail(`package checks failed: ${label}`, { error });
    throw error;
  } finally {
    if (packedDist) {
      await packedDist.cleanup();
    }
  }
}

export async function auditPublishedPackageBoundaries(
  target: PublishedPackageBoundaryTarget,
): Promise<PublishedPackageBoundaryViolation[]> {
  const manifestPath = path.join(target.outDir, 'package.json');
  const manifest = await readDistPackageJson({
    packageJsonPath: manifestPath,
  });
  const allowedExternalPackages = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...(target.ignoredExternalPackages ?? []),
  ]);
  const selfSpecifiers = collectSelfSpecifierMatchers(
    manifest.name,
    manifest.exports,
  );
  const publishedFiles = await collectPublishedModuleFiles(target.outDir);
  const violations: PublishedPackageBoundaryViolation[] = [];

  await init;

  for (const filePath of publishedFiles) {
    const relativeFilePath = path.relative(target.outDir, filePath);
    const environment = classifyRuntimeEnvironment(target, relativeFilePath);
    const source = await readFile(filePath, 'utf8');
    const [importSpecifiers] = parse(source);

    for (const importSpecifier of importSpecifiers) {
      if (!importSpecifier.n) {
        continue;
      }

      const message = validatePublishedSpecifier({
        allowedExternalPackages,
        environment,
        importsField: manifest.imports,
        outDir: target.outDir,
        packageName: manifest.name,
        selfSpecifiers,
        specifier: importSpecifier.n,
      });

      if (!message) {
        continue;
      }

      violations.push({
        environment,
        filePath: relativeFilePath,
        message,
        specifier: importSpecifier.n,
      });
    }
  }

  return violations.toSorted((left, right) => {
    if (left.filePath === right.filePath) {
      return left.specifier.localeCompare(right.specifier);
    }

    return left.filePath.localeCompare(right.filePath);
  });
}

export async function runPackageCheckImpl(
  options: RunPackageCheckOptions,
): Promise<boolean> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const preflight = resolvePreflight(options.config, options);
  const plan = await preflight.ensurePackageEntrySelectionPlan({
    cwd,
    packageNames: options.packageNames,
    requireCwdPackageMatch: false,
    tool: options.tool,
  });

  logPackageCheckPlan({
    config: options.config,
    cwd,
    plan,
  });

  const runnableEntries = plan.entries.filter(
    (entry) => entry.checks.length > 0,
  );

  if (runnableEntries.length === 0) {
    throw new Error(
      options.tool && options.tool !== 'all'
        ? `No package entries have "${options.tool}" enabled.`
        : 'No package checks are enabled.',
    );
  }

  const progressItems = new Map(
    runnableEntries.map((entry) => [
      entry.label,
      options.progress?.planItem(`${entry.label} (${entry.checks.join(', ')})`),
    ]),
  );

  const entryResults = await runPool({
    concurrency: resolvePackageEntryConcurrency({
      config: options.config,
      itemCount: runnableEntries.length,
    }),
    items: runnableEntries,
    onError: (entry, error): PackageCheckEntryRunResult => ({
      checkedToolCount: entry.checks.length,
      durationMs: 0,
      issues: [
        createTaskFailureIssue({
          code: 'LIMINA_PACKAGE_CHECK_FAILED',
          detailLines: [formatErrorMessage(error)],
          filePath: options.config.configPath,
          fix: 'Inspect the package check error above, then rerun `limina package check`.',
          packageName: entry.label,
          reason: `Package check failed: ${formatErrorMessage(error)}.`,
          rootDir: options.config.rootDir,
          task: 'package:check',
          title: 'Package check failed',
          tool: 'package',
        }),
      ],
      label: entry.label,
      passed: false,
      skippedToolCount: 0,
    }),
    onResult: (entry, result) => {
      const progressItem = progressItems.get(entry.label);

      if (result.passed) {
        progressItem?.pass(undefined, { elapsedTimeMs: result.durationMs });
      } else {
        progressItem?.fail(undefined, { elapsedTimeMs: result.durationMs });
      }
    },
    onStart: (entry) => {
      progressItems.get(entry.label)?.start();
    },
    run: async (entry): Promise<PackageCheckEntryRunResult> => {
      const issues: LiminaCheckIssue[] = [];
      const startedAt = performance.now();
      const entryResult = await runPackageCheckEntry({
        attwProfile: options.attwProfile,
        checks: entry.checks,
        config: options.config,
        flow: options.flow,
        flowDepth: (options.flowDepth ?? 0) + 1,
        issueSink: issues,
        label: entry.label,
        outDir: entry.outDir,
        progressItem: progressItems.get(entry.label),
        rawEntry: entry.rawEntry,
      });

      return {
        checkedToolCount: entryResult.checkedToolCount,
        durationMs: performance.now() - startedAt,
        issues,
        label: `${entry.label} (${entry.checks.join(', ')})`,
        passed: entryResult.passed,
        skippedToolCount: entryResult.skippedToolCount,
      };
    },
  });
  const checkItems: LiminaCheckRunCheckItemSummary[] = entryResults.map(
    (result) =>
      result.passed &&
      result.checkedToolCount === 0 &&
      result.skippedToolCount > 0
        ? createSkippedCheckItemStats({
            durationMs: result.durationMs,
            name: result.label,
          })
        : createCheckItemStats({
            durationMs: result.durationMs,
            issues: result.passed ? 0 : Math.max(1, result.issues.length),
            name: result.label,
            total: result.checkedToolCount,
          }),
  );
  const passed = entryResults.every((result) => result.passed);

  options.issues?.push(...entryResults.flatMap((result) => result.issues));

  options.onStats?.({
    items: checkItems,
    passed: checkItems.reduce(
      (total, item) => total + (item.checksPassed ?? 0),
      0,
    ),
    total: checkItems.reduce(
      (total, item) => total + (item.checksTotal ?? 0),
      0,
    ),
  });

  return passed;
}
