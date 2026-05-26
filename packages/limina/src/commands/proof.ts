import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { getCheckerAdapter, normalizeExtensions } from '../checkers';
import {
  getActiveCheckerExtensions,
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '../config';
import type { LiminaFlowReporter } from '../flow';
import { ProofLogger, clearCliScreen, formatErrorMessage } from '../logger';
import {
  collectCheckerEntryProjectRoutes,
  collectGraphProjectRouteFromRoot,
  collectGraphProjectRoutes,
  createExtensionPattern,
  createExtraFileExtensions,
  createFormatHost,
  getDtsCompanionConfigPath,
  isOrdinaryTypecheckConfigPath,
  parseProjectFileNamesForExtensions,
  readJsonConfig,
  resolveProjectConfigPath,
  resolveReferencePath,
  type CheckerGraphProjectRoute,
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

type ConfigFileOwners = Map<string, string[]>;

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

const typeScriptCheckerExtensions =
  getCheckerAdapter('tsc')?.defaultExtensions ?? [];

function getFirstClassCoverageExtensions(extensions: string[]): string[] {
  return normalizeExtensions([...typeScriptCheckerExtensions, ...extensions]);
}

function getCheckerCoverageExtensions(
  checker: ResolvedCheckerConfig,
): string[] {
  const adapter = getCheckerAdapter(checker.preset);

  if (!adapter?.sourceGraph) {
    return checker.extensions;
  }

  return getFirstClassCoverageExtensions(checker.extensions);
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

  rawEntries.forEach((entry, index) => {
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
      return;
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
      return;
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
      return;
    }

    entries.push({
      filePath: normalizeAbsolutePath(path.join(config.rootDir, fileValue)),
      reason: reasonValue.trim(),
    });
  });

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

function collectCoverage(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  includeAllowlist?: boolean;
  allowlistEntries: AllowlistEntry[];
  checkerTargets: CheckerCoverageTarget[];
  sourceFiles: Set<string>;
}): Map<string, CoverageSource[]> {
  const coverageByFile = new Map<string, CoverageSource[]>();

  for (const route of options.graphRoutes) {
    for (const graphProjectPath of route.projectPaths) {
      for (const filePath of parseProjectFileNamesForExtensions(
        options.config,
        graphProjectPath,
        getFirstClassCoverageExtensions(route.extensions),
      )) {
        if (!options.sourceFiles.has(filePath)) {
          continue;
        }

        addCoverage(coverageByFile, filePath, {
          label: toRelativePath(options.config.rootDir, graphProjectPath),
          type: 'graph',
        });
      }
    }
  }

  for (const checkerTarget of options.checkerTargets) {
    for (const configPath of checkerTarget.coverageConfigPaths) {
      for (const filePath of parseProjectFileNamesForExtensions(
        options.config,
        configPath,
        getCheckerCoverageExtensions(checkerTarget.checker),
      )) {
        if (!options.sourceFiles.has(filePath)) {
          continue;
        }

        addCoverage(coverageByFile, filePath, {
          label: `${toRelativePath(
            options.config.rootDir,
            configPath,
          )} via ${checkerTarget.label}`,
          type: 'checker',
        });
      }
    }
  }

  if (options.includeAllowlist !== false) {
    for (const entry of options.allowlistEntries) {
      if (!options.sourceFiles.has(entry.filePath)) {
        continue;
      }

      addCoverage(coverageByFile, entry.filePath, {
        label: entry.reason,
        type: 'allowlist',
      });
    }
  }

  return coverageByFile;
}

function collectProjectExtensionsByPath(
  routes: CheckerGraphProjectRoute[],
): Map<string, string[]> {
  const projectExtensionsByPath = new Map<string, string[]>();

  for (const route of routes) {
    for (const projectPath of route.projectPaths) {
      const extensions = new Set([
        ...(projectExtensionsByPath.get(projectPath) ?? []),
        ...route.extensions,
      ]);

      projectExtensionsByPath.set(projectPath, [...extensions].sort());
    }
  }

  return projectExtensionsByPath;
}

function parseConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  extensions: string[] = [],
): ParsedConfig {
  const diagnostics: ts.Diagnostic[] = [];
  const configObject = readJsonConfig(config, configPath);
  const parsed = ts.parseJsonConfigFileContent(
    configObject,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
    undefined,
    createExtraFileExtensions(extensions),
  );

  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        createFormatHost(config.rootDir),
      ),
    );
  }

  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsed.errors,
        createFormatHost(config.rootDir),
      ),
    );
  }

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

function addDtsConfigProblems(options: {
  config: ResolvedLiminaConfig;
  graphProjectPaths: Set<string>;
  problems: string[];
  dtsConfigPaths: string[];
  projectExtensionsByPath: Map<string, string[]>;
}): void {
  for (const configPath of options.dtsConfigPaths) {
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

    const extensions = options.projectExtensionsByPath.get(configPath) ?? [];
    const dtsConfig = parseConfig(options.config, configPath, extensions);
    const localConfig = parseConfig(
      options.config,
      localConfigPath,
      extensions,
    );

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

    configObject.references.forEach((reference, index) => {
      if (!isPlainRecord(reference) || typeof reference.path !== 'string') {
        return;
      }

      const referencePath = resolveReferencePath(configPath, reference.path);

      if (isOrdinaryTypecheckConfigPath(referencePath)) {
        return;
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
    });
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

      for (const filePath of parseProjectFileNamesForExtensions(
        config,
        configPath,
        route.extensions,
      )) {
        if (!sourceFiles.has(filePath)) {
          continue;
        }

        const owners = ownersByFile.get(filePath) ?? [];

        owners.push(configPath);
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
    const uniqueOwners = [...new Set(owners)];

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
  const entryProjectExtensionsByPath = collectProjectExtensionsByPath(
    entryRouteCollection.routes,
  );
  const dtsConfigPaths = await collectDtsConfigPaths(config);
  const buildGraphConfigPaths = await collectBuildGraphConfigPaths(config);
  const defaultTsconfigPaths = await collectDefaultTsconfigPaths(config);
  const ordinaryTypecheckConfigPaths =
    await collectOrdinaryTypecheckConfigPaths(config);

  problems.push(...graphRouteCollection.problems);
  problems.push(...entryRouteCollection.problems);

  addDtsConfigProblems({
    config,
    dtsConfigPaths,
    graphProjectPaths: entryProjectPathSet,
    problems,
    projectExtensionsByPath: entryProjectExtensionsByPath,
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

  const baseCoverageByFile = collectCoverage({
    allowlistEntries,
    checkerTargets,
    config,
    graphRoutes: graphRouteCollection.routes,
    includeAllowlist: false,
    sourceFiles,
  });
  const coverageByFile = collectCoverage({
    allowlistEntries,
    checkerTargets,
    config,
    graphRoutes: graphRouteCollection.routes,
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
