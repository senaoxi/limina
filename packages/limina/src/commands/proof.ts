import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type ts from 'typescript';
import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '../checkers';
import {
  getActiveCheckerExtensions,
  getActiveCheckers,
  isStrictConfig,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '../config';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, formatErrorMessage, ProofLogger } from '../logger';
import {
  type CheckerGraphProjectRoute,
  collectCheckerEntryProjectRoutes,
  collectGraphProjectRouteFromRoot,
  collectGraphProjectRoutes,
  createExtensionPattern,
  getDtsCompanionConfigPath,
  isBuildGraphConfigPath,
  isDtsConfigPath,
  isOrdinaryTypecheckConfigPath,
  type JsonObject,
  parseProjectFileNamesForExtensions,
  readJsonConfig,
  resolveProjectConfigPath,
  resolveReferencePath,
} from '../tsconfig';
import { normalizeAbsolutePath, toRelativePath } from '../utils/path';

interface CheckerCoverageTarget {
  checker: ResolvedCheckerConfig;
  configPath: string;
  coverageConfigPaths: string[];
  label: string;
}

interface CheckerCoverageTargetCollection {
  problems: string[];
  targets: CheckerCoverageTarget[];
}

interface AllowlistEntry {
  filePath: string;
  reason: string;
}

interface AllowlistEntryCollection {
  entries: AllowlistEntry[];
  problems: string[];
}

interface CoverageSource {
  label: string;
  type: 'allowlist' | 'checker' | 'graph';
}

export interface RunProofCheckOptions {
  clearScreen?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

interface ConfigFileOwner {
  checkerPreset: ResolvedCheckerConfig['preset'];
  configPath: string;
}

type ConfigFileOwners = Map<string, ConfigFileOwner[]>;

interface ParsedConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

const dtsConfigPattern = '**/tsconfig*.dts.json';
const buildGraphConfigPattern = '**/tsconfig*.build.json';
const tsconfigJsonPattern = '**/tsconfig.json';
const tsconfigFilePattern = '**/tsconfig*.json';
const defaultSourceExclude = [
  'node_modules',
  'dist',
  '.git',
  '.tsbuild',
  'coverage',
  '**/tsconfig*.json',
  '**/package.json',
  '**/project.json',
  '.prettierrc.json',
  '.markdownlint.json',
  'vercel.json',
];

const ignoredSemanticCompilerOptions = new Set([
  'baseUrl',
  'build',
  'composite',
  'configFilePath',
  'declaration',
  'declarationDir',
  'declarationMap',
  'emitBOM',
  'emitDeclarationOnly',
  'incremental',
  'inlineSourceMap',
  'inlineSources',
  'mapRoot',
  'newLine',
  'noEmit',
  'noEmitOnError',
  'out',
  'outDir',
  'outFile',
  'paths',
  'pathsBasePath',
  'preserveConstEnums',
  'project',
  'removeComments',
  'rootDir',
  'showConfig',
  'sourceMap',
  'sourceRoot',
  'tsBuildInfoFile',
]);

function getCheckerCoverageExtensions(
  checker: ResolvedCheckerConfig,
): string[] {
  return checker.extensions;
}

function getActiveCheckerContext(
  config: ResolvedLiminaConfig,
): CheckerProjectParseContext {
  return {
    checkerPresets: [
      ...new Set(getActiveCheckers(config).map((checker) => checker.preset)),
    ],
    extensions: getActiveCheckerExtensions(config),
  };
}

function createCheckerProjectContext(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extensions: string[];
  preset: ResolvedCheckerConfig['preset'];
}): CheckerProjectParseContext {
  const adapterExtensions = resolveCheckerProjectExtensions({
    configPath: options.configPath,
    preset: options.preset,
    projectRootDir: options.config.rootDir,
  });

  return {
    checkerPresets: [options.preset],
    extensions: normalizeExtensions([
      ...options.extensions,
      ...adapterExtensions,
    ]),
  };
}

async function collectTsconfigPaths(
  config: ResolvedLiminaConfig,
  pattern: string,
): Promise<string[]> {
  const paths = await glob(pattern, {
    cwd: config.rootDir,
    absolute: true,
    ignore: [
      '**/.git/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
    ],
  });

  return paths.map(normalizeAbsolutePath).sort();
}

async function collectDtsConfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  return collectTsconfigPaths(config, dtsConfigPattern);
}

async function collectBuildGraphConfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  return collectTsconfigPaths(config, buildGraphConfigPattern);
}

async function collectDefaultTsconfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  return collectTsconfigPaths(config, tsconfigJsonPattern);
}

async function collectOrdinaryTypecheckConfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  const paths = await collectTsconfigPaths(config, tsconfigFilePattern);

  return paths.filter(isOrdinaryTypecheckConfigPath);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?[\]{}()!+@]/u.test(pattern);
}

function isDirectoryShorthand(pattern: string): boolean {
  return (
    !hasGlobSyntax(pattern) && !pattern.includes('/') && !path.extname(pattern)
  );
}

function normalizeSourceExcludePattern(pattern: string): string[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');

  if (!normalized) {
    return [];
  }

  if (isDirectoryShorthand(normalized)) {
    return [`${normalized}/**`, `**/${normalized}/**`];
  }

  if (hasGlobSyntax(normalized)) {
    return [normalized];
  }

  if (normalized.includes('/')) {
    return [normalized, `${normalized}/**`];
  }

  return [normalized, `**/${normalized}`];
}

function sourceIncludePatterns(config: ResolvedLiminaConfig): string[] {
  if (config.config?.source?.include) {
    return config.config.source.include;
  }

  return getActiveCheckerExtensions(config).map(
    (extension) => `**/*${extension}`,
  );
}

function sourceExcludePatterns(config: ResolvedLiminaConfig): string[] {
  return (config.config?.source?.exclude ?? defaultSourceExclude).flatMap(
    normalizeSourceExcludePattern,
  );
}

async function collectExpectedSourceFiles(
  config: ResolvedLiminaConfig,
): Promise<Set<string>> {
  const explicitInclude = config.config?.source?.include !== undefined;
  const proofFilePattern = explicitInclude
    ? null
    : createExtensionPattern(getActiveCheckerExtensions(config));
  const files = await glob(sourceIncludePatterns(config), {
    cwd: config.rootDir,
    absolute: true,
    ignore: sourceExcludePatterns(config),
    onlyFiles: true,
  });

  return new Set(
    files
      .map(normalizeAbsolutePath)
      .filter((filePath) => proofFilePattern?.test(filePath) ?? true)
      .sort(),
  );
}

function collectCheckerCoverageTargets(
  config: ResolvedLiminaConfig,
): CheckerCoverageTargetCollection {
  const problems: string[] = [];
  const targets: CheckerCoverageTarget[] = [];

  for (const checker of getActiveCheckers(config)) {
    const configPath = resolveProjectConfigPath(config.rootDir, checker.entry);

    if (!existsSync(configPath)) {
      problems.push(
        [
          'Checker proof entry references a missing tsconfig:',
          `  checker: ${checker.name}`,
          `  config: ${toRelativePath(config.rootDir, configPath)}`,
        ].join('\n'),
      );
      continue;
    }

    const routeCollection = collectGraphProjectRouteFromRoot({
      rootConfigPath: configPath,
      rootDir: config.rootDir,
    });

    problems.push(...routeCollection.problems);
    targets.push({
      checker,
      configPath,
      coverageConfigPaths: routeCollection.projectPaths,
      label: `${checker.name}:entry`,
    });
  }

  return {
    problems,
    targets,
  };
}

function collectConfiguredAllowlistEntries(
  config: ResolvedLiminaConfig,
): AllowlistEntryCollection {
  const entries: AllowlistEntry[] = [];
  const problems: string[] = [];
  const rawEntries = config.proof?.allowlist;

  if (rawEntries === undefined) {
    return {
      entries,
      problems,
    };
  }

  if (!Array.isArray(rawEntries)) {
    problems.push(
      [
        'Invalid proof allowlist config:',
        '  field: proof.allowlist',
        `  value: ${formatUnknownValue(rawEntries)}`,
        '  reason: proof.allowlist must be an array.',
      ].join('\n'),
    );
    return {
      entries,
      problems,
    };
  }

  for (const [index, entry] of rawEntries.entries()) {
    const field = `proof.allowlist[${index}]`;

    if (!isPlainRecord(entry)) {
      problems.push(
        [
          'Invalid proof allowlist config:',
          `  field: ${field}`,
          `  value: ${formatUnknownValue(entry)}`,
          '  reason: allowlist entries must be objects with non-empty file and reason fields.',
        ].join('\n'),
      );
      continue;
    }

    const fileValue = entry.file;
    const reasonValue = entry.reason;

    if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
      problems.push(
        [
          'Invalid proof allowlist config:',
          `  field: ${field}.file`,
          `  value: ${formatUnknownValue(fileValue)}`,
          '  reason: allowlist file must be a non-empty string.',
        ].join('\n'),
      );
      continue;
    }

    if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
      problems.push(
        [
          'Invalid proof allowlist config:',
          `  field: ${field}.reason`,
          `  value: ${formatUnknownValue(reasonValue)}`,
          '  reason: allowlist reason must be a non-empty string.',
        ].join('\n'),
      );
      continue;
    }

    entries.push({
      filePath: normalizeAbsolutePath(path.join(config.rootDir, fileValue)),
      reason: reasonValue.trim(),
    });
  }

  return {
    entries,
    problems,
  };
}

function addCoverage(
  coverageByFile: Map<string, CoverageSource[]>,
  filePath: string,
  source: CoverageSource,
): void {
  const sources = coverageByFile.get(filePath) ?? [];

  sources.push(source);
  coverageByFile.set(filePath, sources);
}

function parseProjectCoverageFileNames(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
}): string[] {
  return parseCheckerProjectConfigForContext({
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
  }).fileNames;
}

function collectCoverage(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  checkerTargets: CheckerCoverageTarget[];
  outsideSourceCoverageByFile?: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
}): Map<string, CoverageSource[]> {
  const coverageByFile = new Map<string, CoverageSource[]>();

  for (const route of options.graphRoutes) {
    for (const graphProjectPath of route.projectPaths) {
      const projectContext = createCheckerProjectContext({
        config: options.config,
        configPath: graphProjectPath,
        extensions: route.extensions,
        preset: route.checkerPreset,
      });

      for (const filePath of parseProjectCoverageFileNames({
        config: options.config,
        configPath: graphProjectPath,
        context: projectContext,
      })) {
        const coverageSource: CoverageSource = {
          label: toRelativePath(options.config.rootDir, graphProjectPath),
          type: 'graph',
        };

        if (!options.sourceFiles.has(filePath)) {
          if (options.outsideSourceCoverageByFile) {
            addCoverage(
              options.outsideSourceCoverageByFile,
              filePath,
              coverageSource,
            );
          }

          continue;
        }

        addCoverage(coverageByFile, filePath, coverageSource);
      }
    }
  }

  for (const checkerTarget of options.checkerTargets) {
    for (const configPath of checkerTarget.coverageConfigPaths) {
      const projectContext = createCheckerProjectContext({
        config: options.config,
        configPath,
        extensions: getCheckerCoverageExtensions(checkerTarget.checker),
        preset: checkerTarget.checker.preset,
      });

      for (const filePath of parseProjectCoverageFileNames({
        config: options.config,
        configPath,
        context: projectContext,
      })) {
        const coverageSource: CoverageSource = {
          label: `${toRelativePath(
            options.config.rootDir,
            configPath,
          )} via ${checkerTarget.label}`,
          type: 'checker',
        };

        if (!options.sourceFiles.has(filePath)) {
          if (options.outsideSourceCoverageByFile) {
            addCoverage(
              options.outsideSourceCoverageByFile,
              filePath,
              coverageSource,
            );
          }

          continue;
        }

        addCoverage(coverageByFile, filePath, coverageSource);
      }
    }
  }

  return coverageByFile;
}

function cloneCoverageByFile(
  coverageByFile: Map<string, CoverageSource[]>,
): Map<string, CoverageSource[]> {
  return new Map(
    [...coverageByFile.entries()].map(([filePath, sources]) => [
      filePath,
      [...sources],
    ]),
  );
}

function addAllowlistCoverage(options: {
  allowlistEntries: AllowlistEntry[];
  coverageByFile: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
}): void {
  for (const entry of options.allowlistEntries) {
    if (!options.sourceFiles.has(entry.filePath)) {
      continue;
    }

    addCoverage(options.coverageByFile, entry.filePath, {
      label: entry.reason,
      type: 'allowlist',
    });
  }
}

function collectProjectContextsByPath(
  config: ResolvedLiminaConfig,
  routes: CheckerGraphProjectRoute[],
): Map<string, CheckerProjectParseContext> {
  const projectContextsByPath = new Map<string, CheckerProjectParseContext>();

  for (const route of routes) {
    for (const projectPath of route.projectPaths) {
      const existingContext = projectContextsByPath.get(projectPath) ?? {
        checkerPresets: [],
        extensions: [],
      };
      const routeContext = createCheckerProjectContext({
        config,
        configPath: projectPath,
        extensions: route.extensions,
        preset: route.checkerPreset,
      });

      projectContextsByPath.set(projectPath, {
        checkerPresets: [
          ...new Set([
            ...existingContext.checkerPresets,
            ...routeContext.checkerPresets,
          ]),
        ],
        extensions: normalizeExtensions([
          ...existingContext.extensions,
          ...routeContext.extensions,
        ]),
      });
    }
  }

  return projectContextsByPath;
}

function parseConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  context: CheckerProjectParseContext = {
    checkerPresets: [],
    extensions: [],
  },
): ParsedConfig {
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
  });

  return {
    fileNames: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: parsed.options,
  };
}

function formatJsonValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeCompilerOptionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }

  return value;
}

function addDtsConfigSemanticProblems(options: {
  dtsConfigPath: string;
  dtsConfig: ParsedConfig;
  config: ResolvedLiminaConfig;
  localConfigPath: string;
  localConfig: ParsedConfig;
  problems: string[];
}): void {
  const dtsFileNames = new Set(options.dtsConfig.fileNames);
  const localFileNames = new Set(options.localConfig.fileNames);
  const onlyInDts = options.dtsConfig.fileNames.filter(
    (fileName) => !localFileNames.has(fileName),
  );
  const onlyInLocal = options.localConfig.fileNames.filter(
    (fileName) => !dtsFileNames.has(fileName),
  );

  if (onlyInDts.length > 0 || onlyInLocal.length > 0) {
    options.problems.push(
      [
        'DTS config file set does not match its strict local tsconfig:',
        `  config: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
        `  local: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
        ...(onlyInDts.length > 0
          ? [
              '  only in dts config:',
              ...onlyInDts
                .slice(0, 10)
                .map(
                  (fileName) =>
                    `    - ${toRelativePath(options.config.rootDir, fileName)}`,
                ),
              onlyInDts.length > 10
                ? `    ... ${onlyInDts.length - 10} more`
                : '',
            ]
          : []),
        ...(onlyInLocal.length > 0
          ? [
              '  only in local config:',
              ...onlyInLocal
                .slice(0, 10)
                .map(
                  (fileName) =>
                    `    - ${toRelativePath(options.config.rootDir, fileName)}`,
                ),
              onlyInLocal.length > 10
                ? `    ... ${onlyInLocal.length - 10} more`
                : '',
            ]
          : []),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const optionNames = new Set([
    ...Object.keys(options.localConfig.options),
    ...Object.keys(options.dtsConfig.options),
  ]);

  for (const optionName of [...optionNames].sort()) {
    if (ignoredSemanticCompilerOptions.has(optionName)) {
      continue;
    }

    const localValue = normalizeCompilerOptionValue(
      (options.localConfig.options as Record<string, unknown>)[optionName],
    );
    const dtsValue = normalizeCompilerOptionValue(
      (options.dtsConfig.options as Record<string, unknown>)[optionName],
    );

    if (formatJsonValue(localValue) === formatJsonValue(dtsValue)) {
      continue;
    }

    options.problems.push(
      [
        'DTS config overrides a typecheck compiler option from its strict local tsconfig:',
        `  config: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
        `  local: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
        `  option: compilerOptions.${optionName}`,
        `  local: ${formatJsonValue(localValue)}`,
        `  dts: ${formatJsonValue(dtsValue)}`,
      ].join('\n'),
    );
  }
}

function getDtsConfigPathForTypecheckConfig(configPath: string): string {
  const directory = path.dirname(configPath);
  const fileName = path.basename(configPath);
  const dtsFileName =
    fileName === 'tsconfig.json'
      ? 'tsconfig.dts.json'
      : fileName.replace(/\.json$/u, '.dts.json');

  return normalizeAbsolutePath(path.join(directory, dtsFileName));
}

function isDefaultTypecheckAggregator(configObject: JsonObject): boolean {
  return Object.hasOwn(configObject, 'references');
}

function normalizeRawExtends(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function resolveRawExtendsPath(configPath: string, rawExtends: string): string {
  const resolvedPath = path.resolve(path.dirname(configPath), rawExtends);

  return normalizeAbsolutePath(
    path.extname(resolvedPath) ? resolvedPath : `${resolvedPath}.json`,
  );
}

function configExtendsPathTransitively(options: {
  config: ResolvedLiminaConfig;
  configObject: JsonObject;
  configPath: string;
  targetConfigPath: string;
}): boolean {
  const visited = new Set([options.configPath]);
  const pending = normalizeRawExtends(options.configObject.extends).map(
    (entry) => resolveRawExtendsPath(options.configPath, entry),
  );

  for (const configPath of pending) {
    if (configPath === options.targetConfigPath) {
      return true;
    }

    if (visited.has(configPath) || !existsSync(configPath)) {
      continue;
    }

    visited.add(configPath);

    const configObject = readJsonConfig(options.config, configPath);

    pending.push(
      ...normalizeRawExtends(configObject.extends).map((entry) =>
        resolveRawExtendsPath(configPath, entry),
      ),
    );
  }

  return false;
}

function addStrictDtsCompanionExtendsProblems(options: {
  config: ResolvedLiminaConfig;
  configObject: JsonObject;
  dtsConfigPath: string;
  localConfigPath: string;
  problems: string[];
}): void {
  const rawExtends = normalizeRawExtends(options.configObject.extends);
  const extendsCompanion = configExtendsPathTransitively({
    config: options.config,
    configObject: options.configObject,
    configPath: options.dtsConfigPath,
    targetConfigPath: options.localConfigPath,
  });

  if (extendsCompanion) {
    return;
  }

  options.problems.push(
    [
      'Strict mode requires declaration leaves to transitively extend their companion typecheck config:',
      `  declaration leaf: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
      `  expected companion: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
      `  direct extends: ${rawExtends.length > 0 ? rawExtends.join(', ') : '(none)'}`,
      '  reason: strict: true requires tsconfig*.dts.json to add only declaration/build output behavior on top of the matching tsconfig*.json.',
    ].join('\n'),
  );
}

function addDtsConfigProblems(options: {
  config: ResolvedLiminaConfig;
  graphProjectPaths: Set<string>;
  problems: string[];
  dtsConfigPaths: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
}): void {
  for (const configPath of options.dtsConfigPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (!options.graphProjectPaths.has(configPath)) {
      options.problems.push(
        [
          'DTS config is not reachable from any checker entry:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        ].join('\n'),
      );
    }

    const localConfigPath = getDtsCompanionConfigPath(configPath);

    if (!existsSync(localConfigPath)) {
      options.problems.push(
        [
          'DTS config is missing its strict local tsconfig:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  expected: ${toRelativePath(options.config.rootDir, localConfigPath)}`,
        ].join('\n'),
      );
      continue;
    }

    if (isStrictConfig(options.config)) {
      addStrictDtsCompanionExtendsProblems({
        config: options.config,
        configObject,
        dtsConfigPath: configPath,
        localConfigPath,
        problems: options.problems,
      });
    }

    const context = options.projectContextsByPath.get(configPath);
    const dtsConfig = parseConfig(options.config, configPath, context);
    const localConfig = parseConfig(options.config, localConfigPath, context);

    if (dtsConfig.options.composite !== true) {
      options.problems.push(
        [
          'DTS config is not valid for tsc -b:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: final compilerOptions.composite must be true.',
        ].join('\n'),
      );
    }

    if (dtsConfig.options.noEmit === true) {
      options.problems.push(
        [
          'DTS config is not valid for tsc -b:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: final compilerOptions.noEmit must not be true.',
        ].join('\n'),
      );
    }

    if (dtsConfig.options.declaration !== true) {
      options.problems.push(
        [
          'DTS config is not valid for declaration emit:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: final compilerOptions.declaration must be true.',
        ].join('\n'),
      );
    }

    if (dtsConfig.options.emitDeclarationOnly !== true) {
      options.problems.push(
        [
          'DTS config is not valid for declaration emit:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: final compilerOptions.emitDeclarationOnly must be true.',
        ].join('\n'),
      );
    }

    addDtsConfigSemanticProblems({
      config: options.config,
      dtsConfig,
      dtsConfigPath: configPath,
      localConfig,
      localConfigPath,
      problems: options.problems,
    });
  }
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function formatConfigRole(role: 'build graph' | 'tsconfig.json'): string {
  return role === 'build graph'
    ? 'Build graph config'
    : 'Default tsconfig.json';
}

function addPureAggregatorProblems(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  problems: string[];
  role: 'build graph' | 'tsconfig.json';
}): void {
  const roleLabel = formatConfigRole(options.role);
  const allowedKeys = new Set(['$schema', 'files', 'references']);
  const extraKeys = Object.keys(options.configObject).filter(
    (key) => !allowedKeys.has(key),
  );

  if (!Object.hasOwn(options.configObject, 'files')) {
    options.problems.push(
      [
        `${roleLabel} is not a pure aggregator:`,
        `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
        '  field: files',
        '  reason: configs with project references must declare files: [].',
      ].join('\n'),
    );
  } else if (!isEmptyArray(options.configObject.files)) {
    options.problems.push(
      [
        `${roleLabel} is not a pure aggregator:`,
        `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
        '  field: files',
        `  value: ${formatUnknownValue(options.configObject.files)}`,
        '  reason: configs with project references must declare files: [].',
      ].join('\n'),
    );
  }

  if (extraKeys.length > 0) {
    options.problems.push(
      [
        `${roleLabel} is not a pure aggregator:`,
        `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
        `  fields: ${extraKeys.sort().join(', ')}`,
        '  reason: pure aggregators may only declare $schema, files, and references; move source inputs and compiler options into leaf configs.',
      ].join('\n'),
    );
  }
}

function addBuildGraphConfigProblems(options: {
  buildGraphConfigPaths: string[];
  config: ResolvedLiminaConfig;
  problems: string[];
}): void {
  for (const configPath of options.buildGraphConfigPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    addPureAggregatorProblems({
      config: options.config,
      configObject,
      configPath,
      problems: options.problems,
      role: 'build graph',
    });

    if (!isStrictConfig(options.config)) {
      continue;
    }

    if (!Array.isArray(configObject.references)) {
      continue;
    }

    for (const [index, reference] of configObject.references.entries()) {
      if (!isPlainRecord(reference) || typeof reference.path !== 'string') {
        continue;
      }

      const referencePath = resolveReferencePath(configPath, reference.path);

      if (
        isBuildGraphConfigPath(referencePath) ||
        isDtsConfigPath(referencePath)
      ) {
        continue;
      }

      options.problems.push(
        [
          'Strict mode build graph references a non-build project:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  field: references[${index}].path`,
          `  reference: ${reference.path}`,
          `  resolved: ${toRelativePath(options.config.rootDir, referencePath)}`,
          '  reason: strict: true requires tsconfig*.build.json to reference only tsconfig*.build.json aggregators or tsconfig*.dts.json declaration leaves.',
        ].join('\n'),
      );
    }
  }
}

function addDefaultTsconfigShapeProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  tsconfigPaths: string[];
}): void {
  for (const configPath of options.tsconfigPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (!Object.hasOwn(configObject, 'references')) {
      continue;
    }

    addPureAggregatorProblems({
      config: options.config,
      configObject,
      configPath,
      problems: options.problems,
      role: 'tsconfig.json',
    });

    if (!Array.isArray(configObject.references)) {
      continue;
    }

    for (const [index, reference] of configObject.references.entries()) {
      if (!isPlainRecord(reference) || typeof reference.path !== 'string') {
        continue;
      }

      const referencePath = resolveReferencePath(configPath, reference.path);

      if (isOrdinaryTypecheckConfigPath(referencePath)) {
        continue;
      }

      options.problems.push(
        [
          'Default tsconfig.json references a non-typecheck config:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  field: references[${index}].path`,
          `  reference: ${reference.path}`,
          `  resolved: ${toRelativePath(options.config.rootDir, referencePath)}`,
          '  reason: tsconfig.json is the default IDE/typecheck entry and must not reference declaration build graph configs.',
        ].join('\n'),
      );
    }
  }
}

function addDefaultTsconfigEnvironmentProblems(options: {
  config: ResolvedLiminaConfig;
  ordinaryConfigPaths: string[];
  problems: string[];
}): void {
  const configsByDirectory = new Map<string, string[]>();

  for (const configPath of options.ordinaryConfigPaths) {
    const directory = path.dirname(configPath);
    const configs = configsByDirectory.get(directory) ?? [];

    configs.push(configPath);
    configsByDirectory.set(directory, configs);
  }

  for (const [directory, configPaths] of configsByDirectory.entries()) {
    const scopedConfigPaths = configPaths.filter(
      (configPath) => path.basename(configPath) !== 'tsconfig.json',
    );

    if (scopedConfigPaths.length === 0) {
      continue;
    }

    const defaultConfigPath = normalizeAbsolutePath(
      path.join(directory, 'tsconfig.json'),
    );

    if (!existsSync(defaultConfigPath)) {
      options.problems.push(
        [
          'Directory with typecheck environments is missing default tsconfig.json:',
          `  directory: ${toRelativePath(options.config.rootDir, directory)}`,
          '  reason: tsconfig.json is the default IDE/typecheck entry for its directory.',
        ].join('\n'),
      );
      continue;
    }

    if (scopedConfigPaths.length === 1) {
      options.problems.push(
        [
          'Single typecheck environment should use default tsconfig.json:',
          `  config: ${toRelativePath(options.config.rootDir, scopedConfigPaths[0]!)}`,
          `  default: ${toRelativePath(options.config.rootDir, defaultConfigPath)}`,
          '  reason: directories with only one type environment should make tsconfig.json the leaf entry.',
        ].join('\n'),
      );
      continue;
    }

    const defaultConfigObject = readJsonConfig(
      options.config,
      defaultConfigPath,
    );

    if (!Object.hasOwn(defaultConfigObject, 'references')) {
      options.problems.push(
        [
          'Directory with multiple typecheck environments must use tsconfig.json as an aggregator:',
          `  config: ${toRelativePath(options.config.rootDir, defaultConfigPath)}`,
          '  reason: multiple type environments require a default IDE/typecheck aggregator.',
        ].join('\n'),
      );
    }
  }
}

function collectConfigFileOwners(
  config: ResolvedLiminaConfig,
  graphRoutes: CheckerGraphProjectRoute[],
  sourceFiles: Set<string>,
): ConfigFileOwners {
  const ownersByFile: ConfigFileOwners = new Map();

  for (const route of graphRoutes) {
    for (const configPath of route.projectPaths) {
      if (!existsSync(configPath)) {
        continue;
      }

      const projectContext = createCheckerProjectContext({
        config,
        configPath,
        extensions: route.extensions,
        preset: route.checkerPreset,
      });

      for (const filePath of parseProjectFileNamesForExtensions(
        config,
        configPath,
        projectContext,
      )) {
        if (!sourceFiles.has(filePath)) {
          continue;
        }

        const owners = ownersByFile.get(filePath) ?? [];

        owners.push({
          checkerPreset: route.checkerPreset,
          configPath,
        });
        ownersByFile.set(filePath, owners);
      }
    }
  }

  return ownersByFile;
}

function addDuplicateGraphCoverageProblems(options: {
  config: ResolvedLiminaConfig;
  ownersByFile: ConfigFileOwners;
  problems: string[];
}): void {
  for (const [filePath, owners] of [...options.ownersByFile.entries()].sort(
    ([left], [right]) =>
      toRelativePath(options.config.rootDir, left).localeCompare(
        toRelativePath(options.config.rootDir, right),
      ),
  )) {
    const ownersByPreset = new Map<string, ConfigFileOwner[]>();

    for (const owner of owners) {
      const presetOwners = ownersByPreset.get(owner.checkerPreset) ?? [];

      presetOwners.push(owner);
      ownersByPreset.set(owner.checkerPreset, presetOwners);
    }

    for (const presetOwners of ownersByPreset.values()) {
      const uniqueOwners = [
        ...new Set(presetOwners.map((owner) => owner.configPath)),
      ];

      if (uniqueOwners.length <= 1) {
        continue;
      }

      options.problems.push(
        [
          'Duplicate checker graph coverage:',
          `  file: ${toRelativePath(options.config.rootDir, filePath)}`,
          '  covered by:',
          ...uniqueOwners
            .sort((left, right) =>
              toRelativePath(options.config.rootDir, left).localeCompare(
                toRelativePath(options.config.rootDir, right),
              ),
            )
            .map(
              (configPath) =>
                `    - ${toRelativePath(options.config.rootDir, configPath)}`,
            ),
          '  reason: a checker graph file must have a single declaration owner; move the file to one dts leaf or narrow include/exclude patterns.',
        ].join('\n'),
      );
    }
  }
}

function addStrictOrdinaryTypecheckCompanionProblems(options: {
  config: ResolvedLiminaConfig;
  ordinaryConfigPaths: string[];
  problems: string[];
}): void {
  for (const configPath of options.ordinaryConfigPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (
      path.basename(configPath) === 'tsconfig.json' &&
      isDefaultTypecheckAggregator(configObject)
    ) {
      continue;
    }

    const expectedDtsConfigPath =
      getDtsConfigPathForTypecheckConfig(configPath);

    if (existsSync(expectedDtsConfigPath)) {
      continue;
    }

    options.problems.push(
      [
        'Strict mode typecheck config is missing its declaration leaf:',
        `  typecheck config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  expected declaration leaf: ${toRelativePath(options.config.rootDir, expectedDtsConfigPath)}`,
        '  reason: strict: true requires every tsconfig*.json typecheck leaf to have a same-named tsconfig*.dts.json build leaf.',
      ].join('\n'),
    );
  }
}

function addStrictDuplicateTypecheckOwnershipProblems(options: {
  config: ResolvedLiminaConfig;
  ordinaryConfigPaths: string[];
  problems: string[];
}): void {
  const fileOwners = new Map<string, string[]>();
  const context = getActiveCheckerContext(options.config);

  for (const configPath of options.ordinaryConfigPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (
      path.basename(configPath) === 'tsconfig.json' &&
      isDefaultTypecheckAggregator(configObject)
    ) {
      continue;
    }

    for (const fileName of parseConfig(options.config, configPath, context)
      .fileNames) {
      const owners = fileOwners.get(fileName) ?? [];

      owners.push(configPath);
      fileOwners.set(fileName, owners);
    }
  }

  for (const [fileName, owners] of [...fileOwners.entries()].sort(
    ([left], [right]) =>
      toRelativePath(options.config.rootDir, left).localeCompare(
        toRelativePath(options.config.rootDir, right),
      ),
  )) {
    const uniqueOwners = [...new Set(owners)];

    if (uniqueOwners.length <= 1) {
      continue;
    }

    options.problems.push(
      [
        'Strict mode source file belongs to multiple typecheck configs:',
        `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
        '  typecheck configs:',
        ...uniqueOwners
          .sort((left, right) =>
            toRelativePath(options.config.rootDir, left).localeCompare(
              toRelativePath(options.config.rootDir, right),
            ),
          )
          .map(
            (owner) => `    - ${toRelativePath(options.config.rootDir, owner)}`,
          ),
        '  reason: strict: true requires each source module to belong to exactly one tsconfig*.json typecheck leaf.',
      ].join('\n'),
    );
  }
}

function addAllowlistProblems(options: {
  allowlistEntries: AllowlistEntry[];
  baseCoverageByFile: Map<string, CoverageSource[]>;
  config: ResolvedLiminaConfig;
  problems: string[];
  sourceFiles: Set<string>;
}): void {
  for (const entry of options.allowlistEntries) {
    if (!existsSync(entry.filePath)) {
      options.problems.push(
        [
          'Typecheck proof allowlist references a missing file:',
          `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
        ].join('\n'),
      );
      continue;
    }

    if (!options.sourceFiles.has(entry.filePath)) {
      options.problems.push(
        [
          'Typecheck proof allowlist file is outside the configured source boundary:',
          `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
          '  reason: allowlist entries should only describe source files that proof would otherwise require coverage for.',
        ].join('\n'),
      );
      continue;
    }

    if (options.baseCoverageByFile.has(entry.filePath)) {
      options.problems.push(
        [
          'Typecheck proof allowlist file is already covered without the allowlist:',
          `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
        ].join('\n'),
      );
    }
  }
}

function addUncoveredSourceProblems(options: {
  config: ResolvedLiminaConfig;
  coverageByFile: Map<string, CoverageSource[]>;
  problems: string[];
  sourceFiles: Set<string>;
}): void {
  const uncoveredFiles = [...options.sourceFiles].filter(
    (filePath) => !options.coverageByFile.has(filePath),
  );

  if (uncoveredFiles.length === 0) {
    return;
  }

  options.problems.push(
    [
      'Source files are not covered by typecheck proof:',
      ...uncoveredFiles
        .slice(0, 20)
        .map(
          (filePath) =>
            `  - ${toRelativePath(options.config.rootDir, filePath)}`,
        ),
      uncoveredFiles.length > 20
        ? `  ... ${uncoveredFiles.length - 20} more`
        : '',
      '  reason: every file in config.source must be covered by a checker entry or an explicit allowlist entry.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function addSourceBoundaryMismatchProblems(options: {
  config: ResolvedLiminaConfig;
  outsideSourceCoverageByFile: Map<string, CoverageSource[]>;
  problems: string[];
}): void {
  const outsideSourceFiles = [
    ...options.outsideSourceCoverageByFile.entries(),
  ].sort(([left], [right]) => left.localeCompare(right));

  if (outsideSourceFiles.length === 0) {
    return;
  }

  options.problems.push(
    [
      'Typecheck proof source boundary does not match tsconfig coverage:',
      ...outsideSourceFiles
        .slice(0, 20)
        .flatMap(([filePath, sources]) => [
          `  - ${toRelativePath(options.config.rootDir, filePath)}`,
          ...sources
            .slice(0, 3)
            .map((source) => `    covered by: ${source.label}`),
          sources.length > 3 ? `    ... ${sources.length - 3} more` : '',
        ]),
      outsideSourceFiles.length > 20
        ? `  ... ${outsideSourceFiles.length - 20} more`
        : '',
      '  reason: config.source and tsconfig*.json coverage describe different module sets.',
      '  fix: include these files in config.source, exclude them from the related tsconfig*.json, or move intentionally unmanaged files out of checker coverage.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function runProofCheckInternal(
  config: ResolvedLiminaConfig,
  options: { logSuccess?: boolean } = {},
): Promise<boolean> {
  const problems: string[] = [];
  const graphRouteCollection = collectGraphProjectRoutes(config);
  const entryRouteCollection = collectCheckerEntryProjectRoutes(config);
  const entryProjectPaths = [
    ...new Set(
      entryRouteCollection.routes.flatMap((route) => route.projectPaths),
    ),
  ].sort();
  const entryProjectPathSet = new Set(entryProjectPaths);
  const entryProjectContextsByPath = collectProjectContextsByPath(
    config,
    entryRouteCollection.routes,
  );
  const dtsConfigPaths = await collectDtsConfigPaths(config);
  const buildGraphConfigPaths = await collectBuildGraphConfigPaths(config);
  const defaultTsconfigPaths = await collectDefaultTsconfigPaths(config);
  const ordinaryTypecheckConfigPaths =
    await collectOrdinaryTypecheckConfigPaths(config);

  problems.push(
    ...graphRouteCollection.problems,
    ...entryRouteCollection.problems,
  );

  addDtsConfigProblems({
    config,
    dtsConfigPaths,
    graphProjectPaths: entryProjectPathSet,
    problems,
    projectContextsByPath: entryProjectContextsByPath,
  });
  addBuildGraphConfigProblems({
    buildGraphConfigPaths,
    config,
    problems,
  });
  addDefaultTsconfigShapeProblems({
    config,
    problems,
    tsconfigPaths: defaultTsconfigPaths,
  });
  addDefaultTsconfigEnvironmentProblems({
    config,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    problems,
  });

  if (isStrictConfig(config)) {
    addStrictOrdinaryTypecheckCompanionProblems({
      config,
      ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
      problems,
    });
    addStrictDuplicateTypecheckOwnershipProblems({
      config,
      ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
      problems,
    });
  }

  if (problems.length > 0) {
    ProofLogger.error(problems.join('\n\n'));
    return false;
  }

  const checkerTargetCollection = collectCheckerCoverageTargets(config);
  const checkerTargets = checkerTargetCollection.targets;

  problems.push(...checkerTargetCollection.problems);

  if (problems.length > 0) {
    ProofLogger.error(problems.join('\n\n'));
    return false;
  }

  const sourceFiles = await collectExpectedSourceFiles(config);
  const allowlistCollection = collectConfiguredAllowlistEntries(config);
  const allowlistEntries = allowlistCollection.entries;

  problems.push(...allowlistCollection.problems);

  const outsideSourceCoverageByFile = new Map<string, CoverageSource[]>();
  const baseCoverageByFile = collectCoverage({
    checkerTargets,
    config,
    graphRoutes: graphRouteCollection.routes,
    outsideSourceCoverageByFile,
    sourceFiles,
  });
  const coverageByFile = cloneCoverageByFile(baseCoverageByFile);

  addAllowlistCoverage({
    allowlistEntries,
    coverageByFile,
    sourceFiles,
  });
  const graphFileOwners = collectConfigFileOwners(
    config,
    graphRouteCollection.routes,
    sourceFiles,
  );

  addDuplicateGraphCoverageProblems({
    config,
    ownersByFile: graphFileOwners,
    problems,
  });
  addAllowlistProblems({
    allowlistEntries,
    baseCoverageByFile,
    config,
    problems,
    sourceFiles,
  });
  addUncoveredSourceProblems({
    config,
    coverageByFile,
    problems,
    sourceFiles,
  });
  addSourceBoundaryMismatchProblems({
    config,
    outsideSourceCoverageByFile,
    problems,
  });

  if (problems.length > 0) {
    ProofLogger.error(problems.join('\n\n'));
    return false;
  }

  const graphFileCount = [...coverageByFile.values()].filter((sources) =>
    sources.some((source) => source.type === 'graph'),
  ).length;
  const checkerFileCount = [...coverageByFile.values()].filter((sources) =>
    sources.some((source) => source.type === 'checker'),
  ).length;

  if (options.logSuccess ?? true) {
    ProofLogger.success(
      [
        `Checked ${entryProjectPaths.length} checker entry projects and ${dtsConfigPaths.length} dts configs.`,
        `Graph-capable checker entries cover ${graphFileCount} files; checker entries cover ${checkerFileCount} files.`,
        `Configured source boundary covers ${sourceFiles.size} files.`,
      ].join('\n'),
    );
  }

  if (
    (options.logSuccess ?? true) &&
    (config.proof?.allowlist ?? []).length > 0
  ) {
    ProofLogger.info(
      `Explicit typecheck proof allowlist: ${(config.proof?.allowlist ?? [])
        .map((entry) => entry.file)
        .join(', ')}`,
    );
  }

  return true;
}

export async function runProofCheck(
  config: ResolvedLiminaConfig,
  options: RunProofCheckOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('proof check', {
    depth: options.flowDepth ?? 0,
  });

  ProofLogger.info('proof check started');

  try {
    const logSuccess = !options.flow?.interactive;
    const passed = await runProofCheckInternal(config, { logSuccess });

    if (passed) {
      if (logSuccess) {
        ProofLogger.success('proof check finished', elapsed());
      }

      task?.pass();
    } else {
      ProofLogger.error('proof check finished with failures', elapsed());
      task?.fail('proof check finished with failures');
    }

    return passed;
  } catch (error) {
    ProofLogger.error(
      `proof check failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('proof check failed', { error });
    throw error;
  }
}
