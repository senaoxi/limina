import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '#checkers';
import {
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { collectGeneratedSourceConfigPaths } from '#core/build-graph/runner';
import {
  type CheckerGraphProjectRoute,
  collectGraphProjectRouteFromRoot,
  getDtsCompanionConfigPath,
  isBuildGraphConfigPath,
  isDtsConfigPath,
  isOrdinarySourceTypecheckConfigPath,
  isOrdinaryTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type ts from 'typescript';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  type CheckIssueReportOptions,
  formatCheckIssueHumanReport,
} from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import {
  appendCheckIssues,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import {
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import { isSolutionStyleTsconfig } from '../core/build-graph/generated/config-readers';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { ProofLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  addAllowlistCoverage,
  addAllowlistProblems,
  collectConfiguredAllowlistEntries,
} from './allowlist';
import { formatUnknownValue, isPlainRecord } from './config-values';
import {
  addCoverage,
  cloneCoverageByFile,
  type CoverageSource,
} from './coverage';

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

interface ProofProblemIssueHint {
  code: string;
  filePath?: string;
  fix?: string;
  reason?: string;
  title?: string;
}

const proofProblemIssueHints = new Map<string, ProofProblemIssueHint>();

function addProofProblem(
  problems: string[],
  lines: readonly string[],
  hint: ProofProblemIssueHint,
): void {
  const problem = lines.join('\n');

  problems.push(problem);
  proofProblemIssueHints.set(problem, hint);
}

function getProofProblemTitle(problem: string): string {
  const firstLine = problem.split('\n')[0]?.trim() || 'Proof check issue';

  return firstLine.replace(/:+$/u, '');
}

function getProofProblemCode(title: string): string {
  if (title.startsWith('Source files are not covered')) {
    return LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile;
  }

  if (title.startsWith('Typecheck proof source boundary')) {
    return LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch;
  }

  if (
    title.startsWith('Source file belongs to multiple typecheck configs') ||
    title.startsWith(
      'Implementation source file belongs to multiple typecheck configs',
    )
  ) {
    return LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner;
  }

  if (title.startsWith('Duplicate checker graph coverage')) {
    return LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage;
  }

  if (
    title.includes('allowlist') ||
    title.includes('Allowlist') ||
    title.includes('proof.allowlist')
  ) {
    return LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid;
  }

  if (
    title.includes('default tsconfig') ||
    title.includes('Default tsconfig')
  ) {
    return LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid;
  }

  if (title.includes('checker') || title.includes('Checker')) {
    return LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid;
  }

  return LIMINA_CHECK_ISSUE_CODES.proofCheckFailed;
}

function getProblemLineValue(
  problem: string,
  label: string,
): string | undefined {
  const escapedLabel = label.replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    String.raw`\$&`,
  );
  const match = new RegExp(String.raw`^\s*${escapedLabel}:\s*(.+)$`, 'mu').exec(
    problem,
  );

  return match?.[1]?.trim();
}

function createProofCheckIssue(options: {
  config: ResolvedLiminaConfig;
  problem: string;
}): LiminaCheckIssue {
  const hint = proofProblemIssueHints.get(options.problem);
  const title = hint?.title ?? getProofProblemTitle(options.problem);
  const filePath =
    hint?.filePath ??
    getProblemLineValue(options.problem, 'file') ??
    getProblemLineValue(options.problem, 'project') ??
    getProblemLineValue(options.problem, 'config');

  return createTaskFailureIssue({
    code: hint?.code ?? getProofProblemCode(title),
    detailLines: options.problem.split('\n'),
    filePath,
    fix: hint?.fix ?? getProblemLineValue(options.problem, 'fix'),
    reason:
      hint?.reason ??
      getProblemLineValue(options.problem, 'reason') ??
      'Proof check found source coverage or checker graph proof violations.',
    rootDir: options.config.rootDir,
    task: 'proof:check',
    title,
  });
}

function createProofCheckIssues(options: {
  config: ResolvedLiminaConfig;
  existingIssues: readonly LiminaCheckIssue[];
  problems: readonly string[];
}): LiminaCheckIssue[] {
  const existingCodes = new Set(
    options.existingIssues.map((issue) => issue.code),
  );

  return options.problems
    .map((problem) =>
      createProofCheckIssue({
        config: options.config,
        problem,
      }),
    )
    .filter(
      (issue) =>
        issue.code !== 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE' ||
        !existingCodes.has(issue.code),
    );
}

function collectProofReportIssues(options: {
  config: ResolvedLiminaConfig;
  existingIssues?: readonly LiminaCheckIssue[];
  problems: readonly string[];
}): LiminaCheckIssue[] {
  const existingIssues = options.existingIssues ?? [];

  return [
    ...existingIssues,
    ...createProofCheckIssues({
      config: options.config,
      existingIssues,
      problems: options.problems,
    }),
  ];
}

function formatProofProblemReport(options: {
  config: ResolvedLiminaConfig;
  issues?: readonly LiminaCheckIssue[];
  problems: readonly string[];
  report?: CheckIssueReportOptions;
}): string {
  const issues =
    options.issues ??
    collectProofReportIssues({
      config: options.config,
      problems: options.problems,
    });

  return formatCheckIssueHumanReport({
    command: options.report?.command ?? 'limina proof check',
    issues,
    title: 'Proof check summary',
    verbose: options.report?.verbose,
  });
}

export interface RunProofCheckOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

const PROOF_CHECK_ITEM_NAMES = [
  'project routes and configs',
  'checker coverage targets',
  'proof allowlist',
  'source coverage',
] as const;

interface ConfigFileOwner {
  checkerPreset: ResolvedCheckerConfig['preset'];
  configPath: string;
}

type ConfigFileOwners = Map<string, ConfigFileOwner[]>;

interface ParsedConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

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
  'typeRoots',
]);

function getCheckerCoverageExtensions(
  checker: ResolvedCheckerConfig,
): string[] {
  return checker.extensions;
}

function getActiveCheckerContext(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CheckerProjectParseContext {
  const checkers = generatedGraph?.checkers ?? getActiveCheckers(config);

  return {
    checkerPresets: uniqueValues(checkers.map((checker) => checker.preset)),
    extensions: normalizeExtensions(
      checkers.flatMap((checker) => checker.extensions),
    ),
  };
}

function createCheckerProjectContext(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extensions: string[];
  preset: ResolvedCheckerConfig['preset'];
  virtualFiles?: ReadonlyMap<string, string>;
}): CheckerProjectParseContext {
  const adapterExtensions = resolveCheckerProjectExtensions({
    configPath: options.configPath,
    preset: options.preset,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });

  return {
    checkerPresets: [options.preset],
    extensions: normalizeExtensions([
      ...options.extensions,
      ...adapterExtensions,
    ]),
  };
}

function collectCheckerCoverageTargets(
  config: ResolvedLiminaConfig,
  generatedGraph: GeneratedTsconfigGraphResult,
): CheckerCoverageTargetCollection {
  const problems: string[] = [];
  const targets: CheckerCoverageTarget[] = [];

  for (const checker of generatedGraph.checkers) {
    const configPath = generatedGraph.checkerEntries.get(checker.name);

    if (!configPath) {
      addProofProblem(
        problems,
        [
          'Checker proof entry is missing a generated tsconfig:',
          `  checker: ${checker.name}`,
        ],
        {
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          reason:
            'Every active checker needs a generated entry tsconfig before proof can validate coverage.',
          title: 'Checker proof entry is missing a generated tsconfig',
        },
      );
      continue;
    }

    if (
      !existsSync(configPath) &&
      !generatedGraph.generatedFiles.has(normalizeAbsolutePath(configPath))
    ) {
      addProofProblem(
        problems,
        [
          'Checker proof entry references a missing tsconfig:',
          `  checker: ${checker.name}`,
          `  config: ${toRelativePath(config.rootDir, configPath)}`,
        ],
        {
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          filePath: configPath,
          reason:
            'The generated checker entry referenced by proof no longer exists on disk.',
          title: 'Checker proof entry references a missing tsconfig',
        },
      );
      continue;
    }

    const routeCollection = collectGraphProjectRouteFromRoot({
      rootConfigPath: configPath,
      rootDir: config.rootDir,
      virtualFiles: generatedGraph.generatedFiles,
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

function parseProjectCoverageFileNames(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
  virtualFiles: ReadonlyMap<string, string>;
}): string[] {
  return parseCheckerProjectConfigForContext({
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  }).fileNames;
}

function parseProjectCoverage(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
  virtualFiles: ReadonlyMap<string, string>;
}): { fileNames: string[]; ownerRootDir: string } {
  const parsed = parseCheckerProjectConfigForContext({
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });
  const coverageParsed = isDtsConfigPath(options.configPath)
    ? parseCheckerProjectConfigForContext({
        configPath: getProofCompanionConfigPath(
          options.configPath,
          options.virtualFiles,
        ),
        context: options.context,
        projectRootDir: options.config.rootDir,
      })
    : parsed;
  const ownerRootDir = parsed.options.rootDir
    ? normalizeAbsolutePath(parsed.options.rootDir)
    : path.dirname(options.configPath);

  return {
    fileNames: coverageParsed.fileNames,
    ownerRootDir,
  };
}

function collectCoverage(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  checkerTargets: CheckerCoverageTarget[];
  outsideSourceCoverageByFile?: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): Map<string, CoverageSource[]> {
  const coverageByFile = new Map<string, CoverageSource[]>();

  for (const route of options.graphRoutes) {
    for (const graphProjectPath of route.projectPaths) {
      if (!isDtsConfigPath(graphProjectPath)) {
        continue;
      }

      const projectContext = createCheckerProjectContext({
        config: options.config,
        configPath: graphProjectPath,
        extensions: route.extensions,
        preset: route.checkerPreset,
        virtualFiles: options.virtualFiles,
      });

      const projectCoverage = parseProjectCoverage({
        config: options.config,
        configPath: graphProjectPath,
        context: projectContext,
        virtualFiles: options.virtualFiles,
      });

      for (const filePath of projectCoverage.fileNames) {
        if (!isPathInsideDirectory(filePath, projectCoverage.ownerRootDir)) {
          continue;
        }

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
      if (!isDtsConfigPath(configPath)) {
        continue;
      }

      const projectContext = createCheckerProjectContext({
        config: options.config,
        configPath,
        extensions: getCheckerCoverageExtensions(checkerTarget.checker),
        preset: checkerTarget.checker.preset,
        virtualFiles: options.virtualFiles,
      });

      for (const filePath of parseProjectCoverageFileNames({
        config: options.config,
        configPath,
        context: projectContext,
        virtualFiles: options.virtualFiles,
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

function collectProjectContextsByPath(
  config: ResolvedLiminaConfig,
  routes: CheckerGraphProjectRoute[],
): Map<string, CheckerProjectParseContext> {
  const projectContextsByPath = new Map<string, CheckerProjectParseContext>();

  for (const route of routes) {
    for (const projectPath of route.projectPaths) {
      if (!isDtsConfigPath(projectPath)) {
        continue;
      }

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
        checkerPresets: uniqueValues([
          ...existingContext.checkerPresets,
          ...routeContext.checkerPresets,
        ]),
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
  virtualFiles?: ReadonlyMap<string, string>,
): ParsedConfig {
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
    virtualFiles,
  });

  return {
    fileNames: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: parsed.options,
  };
}

function readProofConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  const content = virtualFiles?.get(normalizeAbsolutePath(configPath));
  return content
    ? (JSON.parse(content) as JsonObject)
    : readJsonConfig(config, configPath);
}

function getProofCompanionConfigPath(
  configPath: string,
  virtualFiles: ReadonlyMap<string, string>,
): string {
  const configObject = readProofConfig(
    { rootDir: path.dirname(configPath) } as ResolvedLiminaConfig,
    configPath,
    virtualFiles,
  );
  const liminaOptions = configObject.liminaOptions;
  const sourceConfig =
    liminaOptions &&
    typeof liminaOptions === 'object' &&
    !Array.isArray(liminaOptions)
      ? (liminaOptions as { sourceConfig?: unknown }).sourceConfig
      : undefined;

  return typeof sourceConfig === 'string'
    ? resolveReferencePath(configPath, sourceConfig)
    : getDtsCompanionConfigPath(configPath);
}

function readRelativeTypeFiles(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  const configObject = readJsonConfig(config, sourceConfigPath);
  const compilerOptions = configObject.compilerOptions;

  if (
    !compilerOptions ||
    typeof compilerOptions !== 'object' ||
    Array.isArray(compilerOptions)
  ) {
    return [];
  }

  const types = (compilerOptions as { types?: unknown }).types;

  if (!Array.isArray(types)) {
    return [];
  }

  return types
    .filter(
      (typeName): typeName is string =>
        typeof typeName === 'string' &&
        (typeName.startsWith('./') || typeName.startsWith('../')),
    )
    .map((typeName) =>
      normalizeAbsolutePath(
        path.resolve(path.dirname(sourceConfigPath), typeName),
      ),
    );
}

function normalizeGeneratedDtsTypes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.filter(
    (typeName) =>
      typeof typeName !== 'string' ||
      (!typeName.startsWith('./') && !typeName.startsWith('../')),
  );
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
  const localFileNames = new Set([
    ...options.localConfig.fileNames,
    ...readRelativeTypeFiles(options.config, options.localConfigPath),
  ]);
  const onlyInDts = options.dtsConfig.fileNames.filter(
    (fileName) => !localFileNames.has(fileName),
  );
  const onlyInLocal = [...localFileNames].filter(
    (fileName) => !dtsFileNames.has(fileName),
  );

  if (onlyInDts.length > 0 || onlyInLocal.length > 0) {
    options.problems.push(
      [
        'DTS config file set does not match its local typecheck config:',
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

    const localOptionValue = (
      options.localConfig.options as Record<string, unknown>
    )[optionName];
    const dtsOptionValue = (
      options.dtsConfig.options as Record<string, unknown>
    )[optionName];
    const localValue = normalizeCompilerOptionValue(
      optionName === 'types'
        ? normalizeGeneratedDtsTypes(localOptionValue)
        : localOptionValue,
    );
    const dtsValue = normalizeCompilerOptionValue(
      optionName === 'types'
        ? normalizeGeneratedDtsTypes(dtsOptionValue)
        : dtsOptionValue,
    );

    if (formatJsonValue(localValue) === formatJsonValue(dtsValue)) {
      continue;
    }

    options.problems.push(
      [
        'DTS config overrides a typecheck compiler option from its local typecheck config:',
        `  config: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
        `  local: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
        `  option: compilerOptions.${optionName}`,
        `  local: ${formatJsonValue(localValue)}`,
        `  dts: ${formatJsonValue(dtsValue)}`,
      ].join('\n'),
    );
  }
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

function addDtsCompanionExtendsProblems(options: {
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
      'Declaration leaf does not transitively extend its companion typecheck config:',
      `  declaration leaf: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
      `  expected companion: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
      `  direct extends: ${rawExtends.length > 0 ? rawExtends.join(', ') : '(none)'}`,
      '  reason: tsconfig*.dts.json must add only declaration/build output behavior on top of the matching tsconfig*.json.',
    ].join('\n'),
  );
}

function addDtsConfigProblems(options: {
  config: ResolvedLiminaConfig;
  graphProjectPaths: Set<string>;
  problems: string[];
  dtsConfigPaths: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  virtualFiles: ReadonlyMap<string, string>;
}): void {
  for (const configPath of options.dtsConfigPaths) {
    const configObject = readProofConfig(
      options.config,
      configPath,
      options.virtualFiles,
    );

    if (!options.graphProjectPaths.has(configPath)) {
      options.problems.push(
        [
          'Source-level DTS config violates the managed config boundary:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: declaration configs are Limina-managed under .limina and derived from checker.include source tsconfigs.',
        ].join('\n'),
      );
      continue;
    }

    const localConfigPath = getProofCompanionConfigPath(
      configPath,
      options.virtualFiles,
    );

    if (!existsSync(localConfigPath)) {
      options.problems.push(
        [
          'DTS config is missing its local typecheck config:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  expected: ${toRelativePath(options.config.rootDir, localConfigPath)}`,
        ].join('\n'),
      );
      continue;
    }

    addDtsCompanionExtendsProblems({
      config: options.config,
      configObject,
      dtsConfigPath: configPath,
      localConfigPath,
      problems: options.problems,
    });

    const context = options.projectContextsByPath.get(configPath);
    const dtsConfig = parseConfig(
      options.config,
      configPath,
      context,
      options.virtualFiles,
    );
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
  const issueLines: string[] = [];
  const allowedKeys = new Set([
    '$schema',
    'files',
    'liminaOptions',
    'references',
  ]);
  const extraKeys = Object.keys(options.configObject).filter(
    (key) => !allowedKeys.has(key),
  );

  if (!Object.hasOwn(options.configObject, 'files')) {
    issueLines.push(
      '  - field: files',
      '    reason: configs with project references must declare files: [].',
    );
  } else if (!isEmptyArray(options.configObject.files)) {
    issueLines.push(
      '  - field: files',
      `    value: ${formatUnknownValue(options.configObject.files)}`,
      '    reason: configs with project references must declare files: [].',
    );
  }

  if (extraKeys.length > 0) {
    issueLines.push(
      `  - fields: ${extraKeys.sort().join(', ')}`,
      '    reason: pure aggregators may only declare $schema, files, references, and Limina metadata; move source inputs and compiler options into leaf configs.',
    );
  }

  if (issueLines.length === 0) {
    return;
  }

  options.problems.push(
    [
      `${roleLabel} is not a pure aggregator:`,
      `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
      '  issues:',
      ...issueLines,
    ].join('\n'),
  );
}

function hasImplicitRefs(configObject: JsonObject): boolean {
  const liminaOptions = configObject.liminaOptions;

  return (
    isPlainRecord(liminaOptions) && Object.hasOwn(liminaOptions, 'implicitRefs')
  );
}

function hasProjectReferencesField(configObject: JsonObject): boolean {
  return Object.hasOwn(configObject, 'references');
}

function addSourceReferenceRoleProblems(options: {
  config: ResolvedLiminaConfig;
  ordinaryConfigPaths: string[];
  problems: string[];
}): void {
  for (const configPath of options.ordinaryConfigPaths) {
    if (!isOrdinarySourceTypecheckConfigPath(configPath)) {
      continue;
    }

    const configObject = readJsonConfig(options.config, configPath);

    if (!hasProjectReferencesField(configObject)) {
      continue;
    }

    const isSolutionStyleConfig = isSolutionStyleTsconfig(
      configPath,
      configObject,
    );

    if (!isSolutionStyleConfig) {
      options.problems.push(
        [
          'Source typecheck config declares project references:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  field: references',
          '  reason: source typecheck configs must not hand-maintain project references; Limina infers static source edges and liminaOptions.implicitRefs documents dynamic or virtual edges.',
          '  fix: remove obsolete tsc -b references from source configs, move IDE aggregation references to a files: [] solution tsconfig.json, or replace dynamic source edges with liminaOptions.implicitRefs.',
        ].join('\n'),
      );
      continue;
    }

    if (hasImplicitRefs(configObject)) {
      options.problems.push(
        [
          'Solution tsconfig declares Limina implicit references:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  field: liminaOptions.implicitRefs',
          '  reason: solution-style tsconfig.json files aggregate typecheck configs and do not own source files, so implicitRefs must live on the source typecheck config that needs the extra edge.',
        ].join('\n'),
      );
    }
  }
}

function addBuildGraphConfigProblems(options: {
  buildGraphConfigPaths: string[];
  config: ResolvedLiminaConfig;
  problems: string[];
  virtualFiles: ReadonlyMap<string, string>;
}): void {
  for (const configPath of options.buildGraphConfigPaths) {
    const configObject = readProofConfig(
      options.config,
      configPath,
      options.virtualFiles,
    );

    if (!configPath.includes('/.limina/')) {
      options.problems.push(
        [
          'Source-level build graph config violates the managed config boundary:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: checker build aggregators are Limina-managed under .limina and derived from checker.include source tsconfigs.',
        ].join('\n'),
      );
      continue;
    }

    addPureAggregatorProblems({
      config: options.config,
      configObject,
      configPath,
      problems: options.problems,
      role: 'build graph',
    });

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
          'Build graph references a non-build project:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  field: references[${index}].path`,
          `  reference: ${reference.path}`,
          `  resolved: ${toRelativePath(options.config.rootDir, referencePath)}`,
          '  reason: tsconfig*.build.json may reference only tsconfig*.build.json aggregators or tsconfig*.dts.json declaration leaves.',
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

    if (!hasProjectReferencesField(configObject)) {
      continue;
    }

    if (!isSolutionStyleTsconfig(configPath, configObject)) {
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
  virtualFiles: ReadonlyMap<string, string>,
): ConfigFileOwners {
  const ownersByFile: ConfigFileOwners = new Map();

  for (const route of graphRoutes) {
    for (const configPath of route.projectPaths) {
      if (!isDtsConfigPath(configPath)) {
        continue;
      }

      if (
        !existsSync(configPath) &&
        !virtualFiles.has(normalizeAbsolutePath(configPath))
      ) {
        continue;
      }

      const projectContext = createCheckerProjectContext({
        config,
        configPath,
        extensions: route.extensions,
        preset: route.checkerPreset,
        virtualFiles,
      });

      const projectCoverage = parseProjectCoverage({
        config,
        configPath,
        context: projectContext,
        virtualFiles,
      });

      for (const filePath of projectCoverage.fileNames) {
        if (!isPathInsideDirectory(filePath, projectCoverage.ownerRootDir)) {
          continue;
        }

        if (!sourceFiles.has(filePath)) {
          continue;
        }

        if (
          !isCheckerGraphDeclarationOwnerCandidate(
            filePath,
            projectContext.extensions,
          )
        ) {
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
      const uniqueOwners = uniqueValues(
        presetOwners.map((owner) => owner.configPath),
      );

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
          '  reason: a declaration-emitting source file must have a single generated dts owner; move the file to one dts leaf or narrow include/exclude patterns.',
        ].join('\n'),
      );
    }
  }
}

function isDeclarationInputFile(fileName: string): boolean {
  return (
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.d.mts') ||
    fileName.endsWith('.d.cts')
  );
}

function isOrdinarySourceOwnershipCandidate(fileName: string): boolean {
  return (
    !isDeclarationInputFile(fileName) &&
    (fileName.endsWith('.ts') ||
      fileName.endsWith('.tsx') ||
      fileName.endsWith('.mts') ||
      fileName.endsWith('.cts'))
  );
}

function isCheckerGraphDeclarationOwnerCandidate(
  fileName: string,
  extensions: readonly string[],
): boolean {
  if (isDeclarationInputFile(fileName)) {
    return false;
  }

  return extensions.some((extension) => {
    const normalizedExtension = extension.startsWith('.')
      ? extension
      : `.${extension}`;

    return fileName.endsWith(normalizedExtension);
  });
}

function addDuplicateTypecheckOwnershipProblems(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  ordinaryConfigPaths: string[];
  problems: string[];
}): void {
  const fileOwners = new Map<string, string[]>();
  const context = getActiveCheckerContext(
    options.config,
    options.generatedGraph,
  );

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
      if (!isOrdinarySourceOwnershipCandidate(fileName)) {
        continue;
      }

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
    const uniqueOwners = uniqueValues(owners);

    if (uniqueOwners.length <= 1) {
      continue;
    }

    options.problems.push(
      [
        'Source file belongs to multiple typecheck configs:',
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
        '  reason: each implementation source file must belong to exactly one tsconfig*.json typecheck leaf.',
      ].join('\n'),
    );
  }
}

function addUncoveredSourceProblems(options: {
  config: ResolvedLiminaConfig;
  coverageByFile: Map<string, CoverageSource[]>;
  issues: LiminaCheckIssue[];
  problems: string[];
  sourceFiles: Set<string>;
}): void {
  const uncoveredFiles = [...options.sourceFiles].filter(
    (filePath) => !options.coverageByFile.has(filePath),
  );

  if (uncoveredFiles.length === 0) {
    return;
  }

  addProofProblem(
    options.problems,
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
    ].filter(Boolean),
    {
      code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
      fix: 'Add uncovered files to a checker entry, exclude them from config.source, or add explicit proof.allowlist entries with reasons.',
      reason:
        'Every file in config.source must be covered by a checker entry or an explicit allowlist entry.',
      title: 'Source files are not covered by typecheck proof',
    },
  );

  for (const filePath of uncoveredFiles) {
    options.issues.push(
      createTaskFailureIssue({
        code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
        filePath,
        fix: 'Add the file to a checker entry, exclude it from config.source, or add an explicit proof.allowlist entry with a reason.',
        reason:
          'Every file in config.source must be covered by a checker entry or an explicit allowlist entry.',
        rootDir: options.config.rootDir,
        task: 'proof:check',
        title: 'Source file is not covered by typecheck proof',
      }),
    );
  }
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

  addProofProblem(
    options.problems,
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
    ].filter(Boolean),
    {
      code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
      fix: 'Include these files in config.source, exclude them from the related tsconfig*.json, or move intentionally unmanaged files out of checker coverage.',
      reason:
        'config.source and tsconfig*.json coverage describe different module sets.',
      title: 'Typecheck proof source boundary does not match tsconfig coverage',
    },
  );
}

export async function runProofCheckImpl(
  config: ResolvedLiminaConfig,
  options: {
    providers?: AnalysisProviderSet;
    deferSnapshot?: boolean;
    generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
    issues?: LiminaCheckIssue[];
    logSuccess?: boolean;
    onStats?: (stats: LiminaCheckRunTaskStats) => void;
    preflight?: LiminaPreflightManager;
    progress?: TaskProgressReporter;
    report?: CheckIssueReportOptions;
  } = {},
): Promise<boolean> {
  const problems: string[] = [];
  const issues: LiminaCheckIssue[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => problems.length + issues.length,
    () => checks.value,
    {
      plannedItems: PROOF_CHECK_ITEM_NAMES,
      progress: options.progress,
    },
  );
  const preflight = resolvePreflight(config, options);
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRouteCollection = await preflight.ensureGraphProjectRoutes();
  const entryRouteCollection =
    await preflight.ensureCheckerEntryProjectRoutes();
  const entryProjectPaths = uniqueSortedStrings(
    entryRouteCollection.routes.flatMap((route) => route.projectPaths),
  );
  const entryProjectPathSet = new Set(entryProjectPaths);
  const entryProjectContextsByPath = collectProjectContextsByPath(
    config,
    entryRouteCollection.routes,
  );
  const dtsConfigPaths = entryProjectPaths.filter(isDtsConfigPath);
  const buildGraphConfigPaths = entryProjectPaths.filter(
    isBuildGraphConfigPath,
  );
  const ordinaryTypecheckConfigPaths =
    collectGeneratedSourceConfigPaths(generatedGraph);
  const defaultTsconfigPaths = ordinaryTypecheckConfigPaths.filter(
    (configPath) => path.basename(configPath) === 'tsconfig.json',
  );
  const proofCheckTotal = entryProjectPaths.length + dtsConfigPaths.length;
  const collectIssues = async (
    reportIssues: readonly LiminaCheckIssue[],
  ): Promise<void> => {
    options.issues?.push(...reportIssues);

    if (options.deferSnapshot) {
      return;
    }

    await appendCheckIssues({
      artifactNamespace: preflight.artifactNamespace,
      issues: reportIssues,
      rootDir: config.rootDir,
    });
  };

  problems.push(
    ...graphRouteCollection.problems,
    ...entryRouteCollection.problems,
  );

  checkItems.start('project routes and configs');
  addDtsConfigProblems({
    config,
    dtsConfigPaths,
    graphProjectPaths: entryProjectPathSet,
    problems,
    projectContextsByPath: entryProjectContextsByPath,
    virtualFiles: generatedGraph.generatedFiles,
  });
  addBuildGraphConfigProblems({
    buildGraphConfigPaths,
    config,
    problems,
    virtualFiles: generatedGraph.generatedFiles,
  });
  addDefaultTsconfigShapeProblems({
    config,
    problems,
    tsconfigPaths: defaultTsconfigPaths,
  });
  addSourceReferenceRoleProblems({
    config,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    problems,
  });
  addDefaultTsconfigEnvironmentProblems({
    config,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    problems,
  });

  addDuplicateTypecheckOwnershipProblems({
    config,
    generatedGraph,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    problems,
  });
  checks.add(proofCheckTotal);
  checkItems.record('project routes and configs');

  if (problems.length > 0) {
    const reportIssues = collectProofReportIssues({
      config,
      problems,
    });

    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    await collectIssues(reportIssues);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofProblemReport({
          config,
          issues: reportIssues,
          problems,
          report: options.report,
        }),
      );
    }
    return false;
  }

  const checkerTargetCollection = collectCheckerCoverageTargets(
    config,
    generatedGraph,
  );
  const checkerTargets = checkerTargetCollection.targets;

  checkItems.start('checker coverage targets');
  problems.push(...checkerTargetCollection.problems);
  checks.add(checkerTargets.length);
  checkItems.record('checker coverage targets');

  if (problems.length > 0) {
    const reportIssues = collectProofReportIssues({
      config,
      problems,
    });

    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    await collectIssues(reportIssues);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofProblemReport({
          config,
          issues: reportIssues,
          problems,
          report: options.report,
        }),
      );
    }
    return false;
  }

  const sourceFiles = await preflight.ensureExpectedSourceFiles();
  const allowlistCollection = collectConfiguredAllowlistEntries(config);
  const allowlistEntries = allowlistCollection.entries;

  checkItems.start('proof allowlist');
  problems.push(...allowlistCollection.problems);
  checks.add(allowlistEntries.length);
  checkItems.record('proof allowlist');

  checkItems.start('source coverage');
  const outsideSourceCoverageByFile = new Map<string, CoverageSource[]>();
  const baseCoverageByFile = collectCoverage({
    checkerTargets,
    config,
    graphRoutes: graphRouteCollection.routes,
    outsideSourceCoverageByFile,
    sourceFiles,
    virtualFiles: generatedGraph.generatedFiles,
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
    generatedGraph.generatedFiles,
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
    issues,
    problems,
    sourceFiles,
  });
  addSourceBoundaryMismatchProblems({
    config,
    outsideSourceCoverageByFile,
    problems,
  });
  checks.add(sourceFiles.size);
  checkItems.record('source coverage');

  if (problems.length > 0) {
    const reportIssues = collectProofReportIssues({
      config,
      existingIssues: issues,
      problems,
    });

    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    await collectIssues(reportIssues);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofProblemReport({
          config,
          issues: reportIssues,
          problems,
          report: options.report,
        }),
      );
    }
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

  options.onStats?.({
    items: checkItems.getItems(),
    passed: checks.value,
    total: checks.value,
  });

  return true;
}
