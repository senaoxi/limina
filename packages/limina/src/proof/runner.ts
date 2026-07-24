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
  type CheckerGraphRouteDiagnostic,
  collectGraphProjectRouteFromRoot,
  getDtsCompanionConfigPath,
  isBuildGraphConfigPath,
  isDtsConfigPath,
  isOrdinarySourceTypecheckConfigPath,
  isOrdinaryTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  resolveReferencePath,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
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
  type LiminaCheckIssue,
  type LiminaCheckIssueEvidence,
  type LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';
import {
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import { isSolutionStyleTsconfig } from '../core/build-graph/generated/config-readers';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { ProofLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  addAllowlistCoverage,
  addAllowlistFindings,
  collectConfiguredAllowlistEntries,
} from './allowlist';
import { formatUnknownValue, isPlainRecord } from './config-values';
import {
  addCoverage,
  cloneCoverageByFile,
  type CoverageSource,
} from './coverage';
import {
  createProofCheckIssuesFromFindings,
  createProofFinding,
  type ProofCheckerCoverageInvalidFacts,
  type ProofFinding,
  type ProofFindingFactsByCode,
  type ProofFindingForCode,
  type ProofSemanticIssueCode,
} from './findings';

interface CheckerCoverageTarget {
  checker: ResolvedCheckerConfig;
  configPath: string;
  coverageConfigPaths: string[];
  label: string;
}

interface CheckerCoverageTargetCollection {
  findings: ProofFinding[];
  targets: CheckerCoverageTarget[];
}

function collectProofReportIssues(options: {
  config: ResolvedLiminaConfig;
  findings: readonly ProofFinding[];
}): LiminaCheckIssue[] {
  return createProofCheckIssuesFromFindings({
    findings: options.findings,
    rootDir: options.config.rootDir,
  });
}

function formatProofFindingReport(options: {
  config: ResolvedLiminaConfig;
  findings: readonly ProofFinding[];
  issues?: readonly LiminaCheckIssue[];
  report?: CheckIssueReportOptions;
}): string {
  const issues =
    options.issues ??
    collectProofReportIssues({
      config: options.config,
      findings: options.findings,
    });

  return formatCheckIssueHumanReport({
    color: shouldUseColor(),
    command: options.report?.command ?? 'limina proof check',
    issues,
    title: 'Proof check summary',
    verbose: options.report?.verbose,
  });
}

interface ProofPackageIdentity {
  packageManifestPath?: string;
  packageName?: string;
}

function getProofPackageIdentity(
  workspaceLookup: WorkspaceLookupIndex,
  filePath: string | undefined,
): ProofPackageIdentity {
  if (!filePath) {
    return {};
  }

  const owner = workspaceLookup.findOwnerForFile(filePath);

  return owner
    ? {
        packageManifestPath: owner.packageJsonPath,
        packageName: owner.name,
      }
    : {};
}

function createProofDiagnosticFinding<
  Code extends ProofSemanticIssueCode,
>(options: {
  checkerName?: string;
  code: Code;
  detailLines: readonly string[];
  evidence?: readonly LiminaCheckIssueEvidence[];
  facts: ProofFindingFactsByCode[Code];
  filePath?: string;
  hint?: string;
  locations?: readonly LiminaCheckIssueLocation[];
  packageIdentity?: ProofPackageIdentity;
  reason: string;
  scope?: string;
  title: string;
}): ProofFindingForCode<Code> {
  return createProofFinding({
    checkerName: options.checkerName,
    code: options.code,
    evidence: options.evidence ?? [
      { label: 'diagnostic', lines: [...options.detailLines] },
    ],
    facts: options.facts,
    filePath: options.filePath,
    hint: options.hint,
    locations: options.locations,
    packageManifestPath: options.packageIdentity?.packageManifestPath,
    packageName: options.packageIdentity?.packageName,
    presentation: {
      detailLines: options.detailLines,
      title: options.title,
    },
    reason: options.reason,
    scope: options.scope,
  } as Omit<ProofFindingForCode<Code>, 'task'>);
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
  checkerEntryPath: string;
  checkerName: string;
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
  'rewriteRelativeImportExtensions',
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

function createProofCheckerRouteFinding(options: {
  checkerName: string;
  diagnostic: CheckerGraphRouteDiagnostic;
  projection: Extract<
    ProofCheckerCoverageInvalidFacts,
    { readonly kind: 'checker-route' }
  >['projection'];
  workspaceLookup: WorkspaceLookupIndex;
}): ProofFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid
> {
  return createProofDiagnosticFinding({
    checkerName: options.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    detailLines: options.diagnostic.detailLines,
    facts: {
      checkerName: options.checkerName,
      configPath: options.diagnostic.filePath,
      diagnosticReason: options.diagnostic.reason,
      diagnosticTitle: options.diagnostic.title,
      kind: 'checker-route',
      projection: options.projection,
    },
    filePath: options.diagnostic.filePath,
    locations: options.diagnostic.filePath
      ? [{ filePath: options.diagnostic.filePath, label: 'checker project' }]
      : undefined,
    packageIdentity: getProofPackageIdentity(
      options.workspaceLookup,
      options.diagnostic.filePath,
    ),
    reason: options.diagnostic.reason,
    title: options.diagnostic.title,
  });
}

function collectCheckerCoverageTargets(
  config: ResolvedLiminaConfig,
  generatedGraph: GeneratedTsconfigGraphResult,
  workspaceLookup: WorkspaceLookupIndex,
): CheckerCoverageTargetCollection {
  const findings: ProofFinding[] = [];
  const targets: CheckerCoverageTarget[] = [];

  for (const checker of generatedGraph.checkers) {
    const configPath = generatedGraph.checkerEntries.get(checker.name);

    if (!configPath) {
      const detailLines = [
        'Checker proof entry is missing a generated tsconfig:',
        `  checker: ${checker.name}`,
      ];

      findings.push(
        createProofDiagnosticFinding({
          checkerName: checker.name,
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            checkerName: checker.name,
            kind: 'checker-entry',
            violation: 'missing-generated-entry',
          },
          reason:
            'Every active checker needs a generated entry tsconfig before proof can validate coverage.',
          title: 'Checker proof entry is missing a generated tsconfig',
        }),
      );
      continue;
    }

    if (
      !existsSync(configPath) &&
      !generatedGraph.generatedFiles.has(normalizeAbsolutePath(configPath))
    ) {
      const detailLines = [
        'Checker proof entry references a missing tsconfig:',
        `  checker: ${checker.name}`,
        `  config: ${toRelativePath(config.rootDir, configPath)}`,
      ];

      findings.push(
        createProofDiagnosticFinding({
          checkerName: checker.name,
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            checkerName: checker.name,
            configPath,
            kind: 'checker-entry',
            violation: 'missing-config',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'checker entry' }],
          packageIdentity: getProofPackageIdentity(workspaceLookup, configPath),
          reason:
            'The generated checker entry referenced by proof no longer exists on disk.',
          title: 'Checker proof entry references a missing tsconfig',
        }),
      );
      continue;
    }

    const routeCollection = collectGraphProjectRouteFromRoot({
      rootConfigPath: configPath,
      rootDir: config.rootDir,
      virtualFiles: generatedGraph.generatedFiles,
    });

    findings.push(
      ...routeCollection.diagnostics.map((diagnostic) =>
        createProofCheckerRouteFinding({
          checkerName: checker.name,
          diagnostic: {
            checkerName: checker.name,
            ...diagnostic,
          },
          projection: 'target',
          workspaceLookup,
        }),
      ),
    );
    targets.push({
      checker,
      configPath,
      coverageConfigPaths: routeCollection.projectPaths,
      label: `${checker.name}:entry`,
    });
  }

  return {
    findings,
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
          checkerEntryPath: route.rootConfigPath,
          checkerName: route.checkerName,
          checkerPreset: route.checkerPreset,
          label: toRelativePath(options.config.rootDir, graphProjectPath),
          projectPath: graphProjectPath,
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
          checkerEntryPath: checkerTarget.configPath,
          checkerName: checkerTarget.checker.name,
          label: `${toRelativePath(
            options.config.rootDir,
            configPath,
          )} via ${checkerTarget.label}`,
          projectPath: configPath,
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
  const configObject = content
    ? (JSON.parse(content) as JsonObject)
    : readJsonConfig(config, configPath);

  validateUserMaintainedLiminaTsconfigMetadata({
    configObject,
    configPath,
  });

  return configObject;
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
  const configObject = readProofConfig(config, sourceConfigPath);
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

function addDtsConfigSemanticFindings(options: {
  dtsConfigPath: string;
  dtsConfig: ParsedConfig;
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  localConfigPath: string;
  localConfig: ParsedConfig;
  workspaceLookup: WorkspaceLookupIndex;
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
    const detailLines = [
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
    ].filter(Boolean);

    options.findings.push(
      createProofDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
        detailLines,
        facts: {
          companionProjectPath: options.localConfigPath,
          declarationProjectPath: options.dtsConfigPath,
          kind: 'declaration-file-set',
          onlyInCompanion: onlyInLocal,
          onlyInDeclaration: onlyInDts,
        },
        filePath: options.dtsConfigPath,
        locations: [
          { filePath: options.dtsConfigPath, label: 'declaration project' },
          { filePath: options.localConfigPath, label: 'typecheck companion' },
        ],
        packageIdentity: getProofPackageIdentity(
          options.workspaceLookup,
          options.localConfigPath,
        ),
        reason:
          'Declaration and companion typecheck configs must cover the same source files.',
        title: 'DTS config file set does not match its local typecheck config',
      }),
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

    const detailLines = [
      'DTS config overrides a typecheck compiler option from its local typecheck config:',
      `  config: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
      `  local: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
      `  option: compilerOptions.${optionName}`,
      `  local: ${formatJsonValue(localValue)}`,
      `  dts: ${formatJsonValue(dtsValue)}`,
    ];

    options.findings.push(
      createProofDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
        detailLines,
        facts: {
          actual: dtsValue,
          companionProjectPath: options.localConfigPath,
          declarationProjectPath: options.dtsConfigPath,
          expected: localValue,
          kind: 'declaration-option-parity',
          optionName,
        },
        filePath: options.dtsConfigPath,
        locations: [
          { filePath: options.dtsConfigPath, label: 'declaration project' },
          { filePath: options.localConfigPath, label: 'typecheck companion' },
        ],
        packageIdentity: getProofPackageIdentity(
          options.workspaceLookup,
          options.localConfigPath,
        ),
        reason:
          'Declaration configs may add output behavior but must preserve companion typecheck semantics.',
        title:
          'DTS config overrides a typecheck compiler option from its local typecheck config',
      }),
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

    const configObject = readProofConfig(options.config, configPath);

    pending.push(
      ...normalizeRawExtends(configObject.extends).map((entry) =>
        resolveRawExtendsPath(configPath, entry),
      ),
    );
  }

  return false;
}

function addDtsCompanionExtendsFindings(options: {
  config: ResolvedLiminaConfig;
  configObject: JsonObject;
  dtsConfigPath: string;
  findings: ProofFinding[];
  localConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
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

  const reason =
    'tsconfig*.dts.json must add only declaration/build output behavior on top of the matching tsconfig*.json.';
  const detailLines = [
    'Declaration leaf does not transitively extend its companion typecheck config:',
    `  declaration leaf: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
    `  expected companion: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
    `  direct extends: ${rawExtends.length > 0 ? rawExtends.join(', ') : '(none)'}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        companionProjectPath: options.localConfigPath,
        declarationProjectPath: options.dtsConfigPath,
        directExtends: rawExtends,
        kind: 'declaration-companion',
        violation: 'not-extended',
      },
      filePath: options.dtsConfigPath,
      locations: [
        { filePath: options.dtsConfigPath, label: 'declaration project' },
        { filePath: options.localConfigPath, label: 'expected companion' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.localConfigPath,
      ),
      reason,
      title:
        'Declaration leaf does not transitively extend its companion typecheck config',
    }),
  );
}

function addDtsConfigFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  graphProjectPaths: Set<string>;
  dtsConfigPaths: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.dtsConfigPaths) {
    const configObject = readProofConfig(
      options.config,
      configPath,
      options.virtualFiles,
    );

    if (!options.graphProjectPaths.has(configPath)) {
      const reason =
        'declaration configs are Limina-managed under .limina and derived from checker.include source tsconfigs.';
      const detailLines = [
        'Source-level DTS config violates the managed config boundary:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            configPath,
            configRole: 'declaration-leaf',
            kind: 'managed-config-boundary',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'declaration config' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title: 'Source-level DTS config violates the managed config boundary',
        }),
      );
      continue;
    }

    const localConfigPath = getProofCompanionConfigPath(
      configPath,
      options.virtualFiles,
    );

    if (!existsSync(localConfigPath)) {
      const detailLines = [
        'DTS config is missing its local typecheck config:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  expected: ${toRelativePath(options.config.rootDir, localConfigPath)}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            companionProjectPath: localConfigPath,
            declarationProjectPath: configPath,
            directExtends: normalizeRawExtends(configObject.extends),
            kind: 'declaration-companion',
            violation: 'missing',
          },
          filePath: configPath,
          locations: [
            { filePath: configPath, label: 'declaration project' },
            { filePath: localConfigPath, label: 'expected companion' },
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            localConfigPath,
          ),
          reason:
            'Every declaration project must have an existing local typecheck companion.',
          title: 'DTS config is missing its local typecheck config',
        }),
      );
      continue;
    }

    addDtsCompanionExtendsFindings({
      config: options.config,
      configObject,
      dtsConfigPath: configPath,
      findings: options.findings,
      localConfigPath,
      workspaceLookup: options.workspaceLookup,
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
      const reason = 'final compilerOptions.composite must be true.';
      const detailLines = [
        'DTS config is not valid for tsc -b:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            actual: dtsConfig.options.composite,
            configPath,
            expected: true,
            kind: 'declaration-compiler-option',
            optionName: 'composite',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'declaration project' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            localConfigPath,
          ),
          reason,
          title: 'DTS config is not valid for tsc -b',
        }),
      );
    }

    if (dtsConfig.options.noEmit === true) {
      const reason = 'final compilerOptions.noEmit must not be true.';
      const detailLines = [
        'DTS config is not valid for tsc -b:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            actual: dtsConfig.options.noEmit,
            configPath,
            expected: false,
            kind: 'declaration-compiler-option',
            optionName: 'noEmit',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'declaration project' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            localConfigPath,
          ),
          reason,
          title: 'DTS config is not valid for tsc -b',
        }),
      );
    }

    if (dtsConfig.options.declaration !== true) {
      const reason = 'final compilerOptions.declaration must be true.';
      const detailLines = [
        'DTS config is not valid for declaration emit:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            actual: dtsConfig.options.declaration,
            configPath,
            expected: true,
            kind: 'declaration-compiler-option',
            optionName: 'declaration',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'declaration project' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            localConfigPath,
          ),
          reason,
          title: 'DTS config is not valid for declaration emit',
        }),
      );
    }

    addDtsConfigSemanticFindings({
      config: options.config,
      dtsConfig,
      dtsConfigPath: configPath,
      findings: options.findings,
      localConfig,
      localConfigPath,
      workspaceLookup: options.workspaceLookup,
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

function addPureAggregatorFindings(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  findings: ProofFinding[];
  role: 'build graph' | 'tsconfig.json';
  workspaceLookup: WorkspaceLookupIndex;
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

  const detailLines = [
    `${roleLabel} is not a pure aggregator:`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  issues:',
    ...issueLines,
  ];
  const commonOptions = {
    detailLines,
    filePath: options.configPath,
    locations: [{ filePath: options.configPath, label: 'aggregator config' }],
    packageIdentity: getProofPackageIdentity(
      options.workspaceLookup,
      options.configPath,
    ),
    reason:
      'Configs with project references must be pure aggregators with files: [] and no source or compiler-option fields.',
    title: `${roleLabel} is not a pure aggregator`,
  } as const;

  options.findings.push(
    options.role === 'build graph'
      ? createProofDiagnosticFinding({
          ...commonOptions,
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          facts: {
            actualFiles: options.configObject.files,
            configPath: options.configPath,
            extraFields: extraKeys,
            kind: 'build-aggregator-shape',
            missingFilesField: !Object.hasOwn(options.configObject, 'files'),
          },
        })
      : createProofDiagnosticFinding({
          ...commonOptions,
          code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
          facts: {
            actualFiles: options.configObject.files,
            configPath: options.configPath,
            extraFields: extraKeys,
            kind: 'aggregator-shape',
            missingFilesField: !Object.hasOwn(options.configObject, 'files'),
          },
        }),
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

function addSourceReferenceRoleFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ordinaryConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.ordinaryConfigPaths) {
    if (!isOrdinarySourceTypecheckConfigPath(configPath)) {
      continue;
    }

    const configObject = readProofConfig(options.config, configPath);

    if (!hasProjectReferencesField(configObject)) {
      continue;
    }

    const isSolutionStyleConfig = isSolutionStyleTsconfig(
      configPath,
      configObject,
    );

    if (!isSolutionStyleConfig) {
      const reason =
        'source typecheck configs must not hand-maintain project references; Limina infers static source edges and liminaOptions.implicitRefs documents dynamic or virtual edges.';
      const hint =
        'Remove obsolete tsc -b references from source configs, move IDE aggregation references to a files: [] solution tsconfig.json, or replace dynamic source edges with liminaOptions.implicitRefs.';
      const detailLines = [
        'Source typecheck config declares project references:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        '  field: references',
        `  reason: ${reason}`,
        `  fix: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            configPath,
            field: 'references',
            kind: 'source-reference-role',
            violation: 'references-on-source-leaf',
          },
          filePath: configPath,
          hint,
          locations: [
            { filePath: configPath, label: 'source typecheck config' },
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title: 'Source typecheck config declares project references',
        }),
      );
      continue;
    }

    if (hasImplicitRefs(configObject)) {
      const reason =
        'solution-style tsconfig.json files aggregate typecheck configs and do not own source files, so implicitRefs must live on the source typecheck config that needs the extra edge.';
      const detailLines = [
        'Solution tsconfig declares Limina implicit references:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        '  field: liminaOptions.implicitRefs',
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            configPath,
            field: 'liminaOptions.implicitRefs',
            kind: 'source-reference-role',
            violation: 'implicit-refs-on-solution',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'solution config' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title: 'Solution tsconfig declares Limina implicit references',
        }),
      );
    }
  }
}

function addBuildGraphConfigFindings(options: {
  buildGraphConfigPaths: string[];
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.buildGraphConfigPaths) {
    const configObject = readProofConfig(
      options.config,
      configPath,
      options.virtualFiles,
    );

    if (!configPath.includes('/.limina/')) {
      const reason =
        'checker build aggregators are Limina-managed under .limina and derived from checker.include source tsconfigs.';
      const detailLines = [
        'Source-level build graph config violates the managed config boundary:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            configPath,
            configRole: 'build-graph',
            kind: 'managed-config-boundary',
          },
          filePath: configPath,
          locations: [{ filePath: configPath, label: 'build graph config' }],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title:
            'Source-level build graph config violates the managed config boundary',
        }),
      );
      continue;
    }

    addPureAggregatorFindings({
      config: options.config,
      configObject,
      configPath,
      findings: options.findings,
      role: 'build graph',
      workspaceLookup: options.workspaceLookup,
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

      const reason =
        'tsconfig*.build.json may reference only tsconfig*.build.json aggregators or tsconfig*.dts.json declaration leaves.';
      const detailLines = [
        'Build graph references a non-build project:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  field: references[${index}].path`,
        `  reference: ${reference.path}`,
        `  resolved: ${toRelativePath(options.config.rootDir, referencePath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
          detailLines,
          facts: {
            configPath,
            configuredPath: reference.path,
            kind: 'build-reference',
            referenceIndex: index,
            resolvedPath: referencePath,
          },
          filePath: configPath,
          locations: [
            { filePath: configPath, label: 'build graph config' },
            { filePath: referencePath, label: 'referenced project' },
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title: 'Build graph references a non-build project',
        }),
      );
    }
  }
}

function addDefaultTsconfigShapeFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  tsconfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.tsconfigPaths) {
    const configObject = readProofConfig(options.config, configPath);

    if (!hasProjectReferencesField(configObject)) {
      continue;
    }

    if (!isSolutionStyleTsconfig(configPath, configObject)) {
      continue;
    }

    addPureAggregatorFindings({
      config: options.config,
      configObject,
      configPath,
      findings: options.findings,
      role: 'tsconfig.json',
      workspaceLookup: options.workspaceLookup,
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

      const reason =
        'tsconfig.json is the default IDE/typecheck entry and must not reference declaration build graph configs.';
      const detailLines = [
        'Default tsconfig.json references a non-typecheck config:',
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  field: references[${index}].path`,
        `  reference: ${reference.path}`,
        `  resolved: ${toRelativePath(options.config.rootDir, referencePath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
          detailLines,
          facts: {
            configPath,
            configuredPath: reference.path,
            kind: 'reference-target',
            referenceIndex: index,
            resolvedPath: referencePath,
          },
          filePath: configPath,
          locations: [
            { filePath: configPath, label: 'default tsconfig' },
            { filePath: referencePath, label: 'referenced config' },
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            configPath,
          ),
          reason,
          title: 'Default tsconfig.json references a non-typecheck config',
        }),
      );
    }
  }
}

function addDefaultTsconfigEnvironmentFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ordinaryConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
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
      const reason =
        'tsconfig.json is the default IDE/typecheck entry for its directory.';
      const detailLines = [
        'Directory with typecheck environments is missing default tsconfig.json:',
        `  directory: ${toRelativePath(options.config.rootDir, directory)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
          detailLines,
          facts: {
            defaultConfigPath,
            directoryPath: directory,
            environmentConfigPaths: scopedConfigPaths,
            kind: 'environment-layout',
            violation: 'missing-default',
          },
          filePath: defaultConfigPath,
          locations: [
            { filePath: defaultConfigPath, label: 'expected default tsconfig' },
            ...scopedConfigPaths.map((filePath) => ({
              filePath,
              label: 'typecheck environment',
            })),
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            directory,
          ),
          reason,
          title:
            'Directory with typecheck environments is missing default tsconfig.json',
        }),
      );
      continue;
    }

    if (scopedConfigPaths.length === 1) {
      const reason =
        'directories with only one type environment should make tsconfig.json the leaf entry.';
      const detailLines = [
        'Single typecheck environment should use default tsconfig.json:',
        `  config: ${toRelativePath(options.config.rootDir, scopedConfigPaths[0]!)}`,
        `  default: ${toRelativePath(options.config.rootDir, defaultConfigPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
          detailLines,
          facts: {
            defaultConfigPath,
            directoryPath: directory,
            environmentConfigPaths: scopedConfigPaths,
            kind: 'environment-layout',
            violation: 'single-environment-uses-named-config',
          },
          filePath: scopedConfigPaths[0],
          locations: [
            { filePath: scopedConfigPaths[0], label: 'named typecheck config' },
            { filePath: defaultConfigPath, label: 'default tsconfig' },
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            defaultConfigPath,
          ),
          reason,
          title:
            'Single typecheck environment should use default tsconfig.json',
        }),
      );
      continue;
    }

    const defaultConfigObject = readProofConfig(
      options.config,
      defaultConfigPath,
    );

    if (!Object.hasOwn(defaultConfigObject, 'references')) {
      const reason =
        'multiple type environments require a default IDE/typecheck aggregator.';
      const detailLines = [
        'Directory with multiple typecheck environments must use tsconfig.json as an aggregator:',
        `  config: ${toRelativePath(options.config.rootDir, defaultConfigPath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
          detailLines,
          facts: {
            defaultConfigPath,
            directoryPath: directory,
            environmentConfigPaths: scopedConfigPaths,
            kind: 'environment-layout',
            violation: 'multiple-environments-not-aggregated',
          },
          filePath: defaultConfigPath,
          locations: [
            { filePath: defaultConfigPath, label: 'default tsconfig' },
            ...scopedConfigPaths.map((filePath) => ({
              filePath,
              label: 'typecheck environment',
            })),
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            defaultConfigPath,
          ),
          reason,
          title:
            'Directory with multiple typecheck environments must use tsconfig.json as an aggregator',
        }),
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
          checkerEntryPath: route.rootConfigPath,
          checkerName: route.checkerName,
          checkerPreset: route.checkerPreset,
          configPath,
        });
        ownersByFile.set(filePath, owners);
      }
    }
  }

  return ownersByFile;
}

function addDuplicateGraphCoverageFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ownersByFile: ConfigFileOwners;
  workspaceLookup: WorkspaceLookupIndex;
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

      const sortedOwners = uniqueOwners.sort((left, right) =>
        toRelativePath(options.config.rootDir, left).localeCompare(
          toRelativePath(options.config.rootDir, right),
        ),
      );
      const checkerNames = uniqueSortedStrings(
        presetOwners.map((owner) => owner.checkerName),
      );
      const graphEntryPaths = uniqueSortedStrings(
        presetOwners.map((owner) => owner.checkerEntryPath),
      );
      const reason =
        'a declaration-emitting source file must have a single generated dts owner; move the file to one dts leaf or narrow include/exclude patterns.';
      const detailLines = [
        'Duplicate checker graph coverage:',
        `  file: ${toRelativePath(options.config.rootDir, filePath)}`,
        '  covered by:',
        ...sortedOwners.map(
          (configPath) =>
            `    - ${toRelativePath(options.config.rootDir, configPath)}`,
        ),
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
          detailLines,
          evidence: [
            { label: 'diagnostic', lines: [...detailLines] },
            ...sortedOwners.map((projectPath) => ({
              label: 'declaration project',
              value: projectPath,
            })),
          ],
          facts: {
            checkerNames,
            checkerPreset: presetOwners[0]!.checkerPreset,
            declarationProjectPaths: sortedOwners,
            graphEntryPaths,
            kind: 'multiple-declaration-projects',
            sourcePath: filePath,
          },
          filePath,
          locations: [
            { filePath, label: 'source' },
            ...sortedOwners.map((projectPath) => ({
              filePath: projectPath,
              label: 'declaration project',
            })),
          ],
          packageIdentity: getProofPackageIdentity(
            options.workspaceLookup,
            filePath,
          ),
          reason,
          title: 'Duplicate checker graph coverage',
        }),
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

function addDuplicateTypecheckOwnershipFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  ordinaryConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const fileOwners = new Map<string, string[]>();
  const context = getActiveCheckerContext(
    options.config,
    options.generatedGraph,
  );

  for (const configPath of options.ordinaryConfigPaths) {
    const configObject = readProofConfig(options.config, configPath);

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

    const sortedOwners = uniqueOwners.sort((left, right) =>
      toRelativePath(options.config.rootDir, left).localeCompare(
        toRelativePath(options.config.rootDir, right),
      ),
    );
    const checkerNames = uniqueSortedStrings(
      [...options.generatedGraph.sourceToBuild.entries()].flatMap(
        ([checkerName, sourceToBuild]) =>
          sortedOwners.some((configPath) => sourceToBuild.has(configPath))
            ? [checkerName]
            : [],
      ),
    );
    const reason =
      'each implementation source file must belong to exactly one tsconfig*.json typecheck leaf.';
    const detailLines = [
      'Source file belongs to multiple typecheck configs:',
      `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
      '  typecheck configs:',
      ...sortedOwners.map(
        (owner) => `    - ${toRelativePath(options.config.rootDir, owner)}`,
      ),
      `  reason: ${reason}`,
    ];

    options.findings.push(
      createProofDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
        detailLines,
        evidence: [
          { label: 'diagnostic', lines: [...detailLines] },
          ...sortedOwners.map((projectPath) => ({
            label: 'owner project',
            value: projectPath,
          })),
        ],
        facts: {
          checkerNames,
          kind: 'multiple-typecheck-owners',
          ownerProjectPaths: sortedOwners,
          sourcePath: fileName,
        },
        filePath: fileName,
        locations: [
          { filePath: fileName, label: 'source' },
          ...sortedOwners.map((projectPath) => ({
            filePath: projectPath,
            label: 'owner project',
          })),
        ],
        packageIdentity: getProofPackageIdentity(
          options.workspaceLookup,
          fileName,
        ),
        reason,
        title: 'Source file belongs to multiple typecheck configs',
      }),
    );
  }
}

function addUncoveredSourceFindings(options: {
  checkerTargets: CheckerCoverageTarget[];
  config: ResolvedLiminaConfig;
  coverageByFile: Map<string, CoverageSource[]>;
  findings: ProofFinding[];
  sourceFiles: Set<string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const uncoveredFiles = [...options.sourceFiles].filter(
    (filePath) => !options.coverageByFile.has(filePath),
  );

  if (uncoveredFiles.length === 0) {
    return;
  }

  const candidateCheckerNames = uniqueSortedStrings(
    options.checkerTargets.map((target) => target.checker.name),
  );
  const candidateProjectPaths = uniqueSortedStrings(
    options.checkerTargets.flatMap((target) => target.coverageConfigPaths),
  );
  const reason =
    'Every file in config.source must be covered by a checker entry or an explicit allowlist entry.';
  const hint =
    'Add the file to a checker entry, exclude it from config.source, or add an explicit proof.allowlist entry with a reason.';

  for (const filePath of uncoveredFiles) {
    options.findings.push(
      createProofDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
        detailLines: [],
        evidence: [
          { label: 'source', value: filePath },
          ...candidateCheckerNames.map((checkerName) => ({
            label: 'candidate checker',
            value: checkerName,
          })),
          ...candidateProjectPaths.map((projectPath) => ({
            label: 'candidate project',
            value: projectPath,
          })),
        ],
        facts: {
          candidateCheckerNames,
          candidateProjectPaths,
          configuredSourceExcludes: [
            ...(options.config.config?.source?.exclude ?? []),
          ],
          configuredSourceIncludes: [
            ...(options.config.config?.source?.include ?? ['...']),
          ],
          coverage: [],
          kind: 'no-checker-or-allowlist-coverage',
          sourcePath: filePath,
        },
        filePath,
        hint,
        locations: [{ filePath, label: 'uncovered source' }],
        packageIdentity: getProofPackageIdentity(
          options.workspaceLookup,
          filePath,
        ),
        reason,
        title: 'Source file is not covered by typecheck proof',
      }),
    );
  }
}

function addSourceBoundaryMismatchFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  outsideSourceCoverageByFile: Map<string, CoverageSource[]>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const outsideSourceFiles = [
    ...options.outsideSourceCoverageByFile.entries(),
  ].sort(([left], [right]) => left.localeCompare(right));

  if (outsideSourceFiles.length === 0) {
    return;
  }

  const reason =
    'config.source and tsconfig*.json coverage describe different module sets.';
  const hint =
    'Include these files in config.source, exclude them from the related tsconfig*.json, or move intentionally unmanaged files out of checker coverage.';
  const detailLines = [
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
    `  reason: ${reason}`,
    `  fix: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`,
  ].filter(Boolean);
  const locations = uniqueValues([
    ...outsideSourceFiles.map(([filePath]) => filePath),
    ...outsideSourceFiles.flatMap(([, sources]) =>
      sources.flatMap((source) =>
        'projectPath' in source ? [source.projectPath] : [],
      ),
    ),
  ]).map((filePath) => ({ filePath, label: 'source or covering project' }));

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
      detailLines,
      evidence: [
        { label: 'diagnostic', lines: [...detailLines] },
        ...outsideSourceFiles.flatMap(([filePath, sources]) =>
          sources.map((source) => ({
            label: 'coverage',
            value: `${filePath} <- ${source.label}`,
          })),
        ),
      ],
      facts: {
        configuredSourceExcludes: [
          ...(options.config.config?.source?.exclude ?? []),
        ],
        configuredSourceIncludes: [
          ...(options.config.config?.source?.include ?? ['...']),
        ],
        kind: 'coverage-outside-source-boundary',
        repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
        sources: outsideSourceFiles.map(([sourcePath, coverage]) => {
          const owner = options.workspaceLookup.findOwnerForFile(sourcePath);

          return {
            coverage: [...coverage],
            packageManifestPath: owner?.packageJsonPath,
            packageName: owner?.name,
            packageRoot: owner?.directory,
            sourcePath,
          };
        }),
      },
      hint,
      locations,
      reason,
      title: 'Typecheck proof source boundary does not match tsconfig coverage',
    }),
  );
}

export async function runProofCheckImpl(
  config: ResolvedLiminaConfig,
  options: {
    providers?: AnalysisProviderSet;
    deferSnapshot?: boolean;
    findingSink?: ProofFinding[];
    generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
    issues?: LiminaCheckIssue[];
    logSuccess?: boolean;
    onStats?: (stats: LiminaCheckRunTaskStats) => void;
    preflight?: LiminaPreflightManager;
    progress?: TaskProgressReporter;
    report?: CheckIssueReportOptions;
  } = {},
): Promise<boolean> {
  const findings: ProofFinding[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length,
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
  const workspaceLookup = await preflight.ensureWorkspaceLookupIndex();
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
  const collectFindings = async (
    reportFindings: readonly ProofFinding[],
  ): Promise<LiminaCheckIssue[]> => {
    options.findingSink?.push(...reportFindings);
    const reportIssues = collectProofReportIssues({
      config,
      findings: reportFindings,
    });

    options.issues?.push(...reportIssues);

    if (options.deferSnapshot) {
      return reportIssues;
    }

    await appendCheckIssues({
      artifactNamespace: preflight.artifactNamespace,
      issues: reportIssues,
      rootDir: config.rootDir,
    });

    return reportIssues;
  };

  findings.push(
    ...graphRouteCollection.diagnostics.map((diagnostic) =>
      createProofCheckerRouteFinding({
        checkerName: diagnostic.checkerName,
        diagnostic,
        projection: 'graph',
        workspaceLookup,
      }),
    ),
    ...entryRouteCollection.diagnostics.map((diagnostic) =>
      createProofCheckerRouteFinding({
        checkerName: diagnostic.checkerName,
        diagnostic,
        projection: 'checker-entry',
        workspaceLookup,
      }),
    ),
  );

  checkItems.start('project routes and configs');
  addDtsConfigFindings({
    config,
    dtsConfigPaths,
    findings,
    graphProjectPaths: entryProjectPathSet,
    projectContextsByPath: entryProjectContextsByPath,
    virtualFiles: generatedGraph.generatedFiles,
    workspaceLookup,
  });
  addBuildGraphConfigFindings({
    buildGraphConfigPaths,
    config,
    findings,
    virtualFiles: generatedGraph.generatedFiles,
    workspaceLookup,
  });
  addDefaultTsconfigShapeFindings({
    config,
    findings,
    tsconfigPaths: defaultTsconfigPaths,
    workspaceLookup,
  });
  addSourceReferenceRoleFindings({
    config,
    findings,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    workspaceLookup,
  });
  addDefaultTsconfigEnvironmentFindings({
    config,
    findings,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    workspaceLookup,
  });

  addDuplicateTypecheckOwnershipFindings({
    config,
    findings,
    generatedGraph,
    ordinaryConfigPaths: ordinaryTypecheckConfigPaths,
    workspaceLookup,
  });
  checks.add(proofCheckTotal);
  checkItems.record('project routes and configs');

  if (findings.length > 0) {
    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    const reportIssues = await collectFindings(findings);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofFindingReport({
          config,
          findings,
          issues: reportIssues,
          report: options.report,
        }),
      );
    }
    return false;
  }

  const checkerTargetCollection = collectCheckerCoverageTargets(
    config,
    generatedGraph,
    workspaceLookup,
  );
  const checkerTargets = checkerTargetCollection.targets;

  checkItems.start('checker coverage targets');
  findings.push(...checkerTargetCollection.findings);
  checks.add(checkerTargets.length);
  checkItems.record('checker coverage targets');

  if (findings.length > 0) {
    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    const reportIssues = await collectFindings(findings);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofFindingReport({
          config,
          findings,
          issues: reportIssues,
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
  findings.push(...allowlistCollection.findings);
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

  const uncoveredFindings: ProofFinding[] = [];
  addUncoveredSourceFindings({
    checkerTargets,
    config,
    coverageByFile,
    findings: uncoveredFindings,
    sourceFiles,
    workspaceLookup,
  });
  findings.unshift(...uncoveredFindings);
  addDuplicateGraphCoverageFindings({
    config,
    findings,
    ownersByFile: graphFileOwners,
    workspaceLookup,
  });
  addAllowlistFindings({
    allowlistEntries,
    baseCoverageByFile,
    config,
    findings,
    sourceFiles,
  });
  addSourceBoundaryMismatchFindings({
    config,
    findings,
    outsideSourceCoverageByFile,
    workspaceLookup,
  });
  checks.add(sourceFiles.size);
  checkItems.record('source coverage');

  if (findings.length > 0) {
    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    const reportIssues = await collectFindings(findings);
    if (!options.report?.defer) {
      ProofLogger.error(
        formatProofFindingReport({
          config,
          findings,
          issues: reportIssues,
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
