import {
  type CheckerProjectParseContext,
  getCheckerAdapter,
  normalizeExtensions,
  resolveCheckerProjectExtensions,
} from '#checkers';
import type { CheckerPreset, ResolvedCheckerConfig } from '#config/runner';
import { getActiveCheckers, type ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { uniqueValues } from '#utils/collections';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { formatUnknownValue } from '#utils/values';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import ts from 'typescript';

export type JsonObject = Record<string, unknown>;

const removedRootLiminaMetadataError = [
  'Invalid Limina tsconfig metadata:',
  '  field: limina',
  '  reason: root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract.',
].join('\n');

const dtsConfigFilePattern = /^tsconfig(?:\..+)?\.dts\.json$/u;
const buildGraphConfigFilePattern = /^tsconfig(?:\..+)?\.build\.json$/u;
const baseConfigFilePattern = /^tsconfig(?:\..+)?\.base\.json$/u;
const checkConfigFilePattern = /^tsconfig(?:\..+)?\.check\.json$/u;
const tsconfigFilePattern = /^tsconfig(?:\..+)?\.json$/u;
// eslint-disable-next-line regexp/no-useless-assertions -- Empty extension sets must match no paths.
const neverMatchingPattern = new RegExp(String.fromCodePoint(97, 94), 'u');
const liminaTsconfigSchemaPath = [
  'node_modules',
  'limina',
  'schemas',
  'tsconfig-schema.json',
];

export interface ReferencePathInfo {
  rawPath: string;
  resolvedPath: string;
}

export interface ReferencePathCollection {
  problems: string[];
  references: ReferencePathInfo[];
}

export interface CollectGraphProjectPathsResult {
  problems: string[];
  projectPaths: string[];
}

export interface CheckerGraphProjectRoute {
  checkerName: string;
  checkerPreset: CheckerPreset;
  extensions: string[];
  projectPaths: string[];
  rootConfigPath: string;
}

export interface CollectCheckerGraphProjectRoutesResult {
  problems: string[];
  routes: CheckerGraphProjectRoute[];
}

export interface CollectSourceGraphProjectExtensionsResult {
  problems: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  projectExtensionsByPath: Map<string, string[]>;
}

export interface CheckerRouteMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name: 'checker-route-projection' | 'checker-route-traversal';
    readonly provider?: string;
  }): void;
}

export type CheckerEntryAvailability =
  | 'available'
  | 'missing-config'
  | 'missing-entry';

export interface CheckerRouteTraversalSnapshot {
  readonly normalizedRootConfigPath: string;
  readonly problems: readonly string[];
  readonly projectPaths: readonly string[];
}

export interface CheckerRouteSnapshot {
  readonly checkerName: string;
  readonly checkerPreset: CheckerPreset;
  readonly entryAvailability: CheckerEntryAvailability;
  readonly extensions: readonly string[];
  readonly normalizedRootConfigPath?: string;
  readonly rootConfigPath?: string;
  readonly supportsSourceGraph: boolean;
  readonly traversal?: CheckerRouteTraversalSnapshot;
}

export interface CheckerRouteSnapshotCollection {
  readonly checkers: readonly CheckerRouteSnapshot[];
  readonly generatedFiles?: ReadonlyMap<string, string>;
  readonly metrics?: CheckerRouteMetricsRecorder;
  readonly traversalCount: number;
  readonly uniqueValidCheckerEntryRoots: number;
}

function createFormatHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => '\n',
  };
}

export function createLiminaTsconfigSchemaPath(
  rootDir: string,
  configPath: string,
): string {
  const relativePath = toPosixPath(
    path.relative(
      path.dirname(configPath),
      path.join(rootDir, ...liminaTsconfigSchemaPath),
    ),
  );

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function createExtensionPattern(extensions: string[]): RegExp {
  if (extensions.length === 0) {
    return neverMatchingPattern;
  }

  return new RegExp(
    `(?:${extensions
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')})$`,
    'u',
  );
}

function readJsonConfigFile(
  rootDir: string,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  const result = ts.readConfigFile(
    configPath,
    (fileName) =>
      virtualFiles?.get(normalizeAbsolutePath(fileName)) ??
      ts.sys.readFile(fileName),
  );

  if (result.error) {
    throw new Error(
      ts.formatDiagnostic(result.error, createFormatHost(rootDir)),
    );
  }

  return result.config as JsonObject;
}

function isGeneratedLiminaConfigPath(configPath: string): boolean {
  return configPath.split(/[\\/]/u).includes('.limina');
}

export function validateUserMaintainedLiminaTsconfigMetadata(options: {
  configObject: JsonObject;
  configPath: string;
}): void {
  if (isGeneratedLiminaConfigPath(options.configPath)) {
    return;
  }

  if (Object.hasOwn(options.configObject, 'limina')) {
    throw new Error(removedRootLiminaMetadataError);
  }
}

export function readJsonConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  return readJsonConfigFile(config.rootDir, configPath, virtualFiles);
}

export function resolveProjectConfigPath(
  baseDirectory: string,
  value?: string,
): string {
  const candidate = value
    ? path.resolve(baseDirectory, value)
    : path.join(baseDirectory, 'tsconfig.json');

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return normalizeAbsolutePath(path.join(candidate, 'tsconfig.json'));
  }

  return normalizeAbsolutePath(candidate);
}

export function resolveReferencePath(
  configPath: string,
  referencePath: string,
): string {
  const absoluteReferencePath = path.resolve(
    path.dirname(configPath),
    referencePath,
  );

  if (path.extname(absoluteReferencePath) === '.json') {
    return normalizeAbsolutePath(absoluteReferencePath);
  }

  return normalizeAbsolutePath(
    path.join(absoluteReferencePath, 'tsconfig.json'),
  );
}

export function getRawReferencePaths(
  config: ResolvedLiminaConfig,
  configPath: string,
): string[] {
  return getRawReferencePathsForConfig(config.rootDir, configPath);
}

export function getRawReferencePathsForConfig(
  rootDir: string,
  configPath: string,
): string[] {
  return collectReferencePathInfosForConfig(rootDir, configPath).references.map(
    (reference) => reference.resolvedPath,
  );
}

export function collectReferencePathInfosForConfig(
  rootDir: string,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): ReferencePathCollection {
  const configObject = readJsonConfigFile(rootDir, configPath, virtualFiles);

  return collectReferencePathInfosFromConfigObject(
    rootDir,
    configPath,
    configObject,
  );
}

function collectReferencePathInfosFromConfigObject(
  rootDir: string,
  configPath: string,
  configObject: JsonObject,
): ReferencePathCollection {
  const references = configObject.references;
  const problems: string[] = [];
  const referenceInfos: ReferencePathInfo[] = [];
  const formatConfigPath = (pathValue: string): string =>
    toRelativePath(rootDir, pathValue);

  if (references === undefined) {
    return {
      problems,
      references: referenceInfos,
    };
  }

  if (!Array.isArray(references)) {
    problems.push(
      [
        'Invalid tsconfig references field:',
        `  config: ${formatConfigPath(configPath)}`,
        `  field: references`,
        `  value: ${formatUnknownValue(references)}`,
        '  reason: references must be an array of objects with a non-empty string path.',
      ].join('\n'),
    );
    return {
      problems,
      references: referenceInfos,
    };
  }

  for (const [index, reference] of references.entries()) {
    const field = `references[${index}]`;

    if (
      !reference ||
      typeof reference !== 'object' ||
      Array.isArray(reference)
    ) {
      problems.push(
        [
          'Invalid tsconfig reference entry:',
          `  config: ${formatConfigPath(configPath)}`,
          `  field: ${field}`,
          `  value: ${formatUnknownValue(reference)}`,
          '  reason: each reference entry must be an object with a non-empty string path.',
        ].join('\n'),
      );
      continue;
    }

    const pathValue = (reference as { path?: unknown }).path;

    if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
      problems.push(
        [
          'Invalid tsconfig reference path:',
          `  config: ${formatConfigPath(configPath)}`,
          `  field: ${field}.path`,
          `  value: ${formatUnknownValue(pathValue)}`,
          '  reason: reference path must be a non-empty string.',
        ].join('\n'),
      );
      continue;
    }

    referenceInfos.push({
      rawPath: pathValue,
      resolvedPath: resolveReferencePath(configPath, pathValue),
    });
  }

  return {
    problems,
    references: referenceInfos,
  };
}

export function isDtsConfigPath(configPath: string): boolean {
  return dtsConfigFilePattern.test(path.basename(configPath));
}

export function getDtsCompanionConfigPath(dtsConfigPath: string): string {
  const configObject = readJsonConfigFile(
    path.dirname(dtsConfigPath),
    dtsConfigPath,
  );
  const liminaOptions = configObject.liminaOptions;

  if (
    liminaOptions &&
    typeof liminaOptions === 'object' &&
    !Array.isArray(liminaOptions)
  ) {
    const sourceConfig = (liminaOptions as { sourceConfig?: unknown })
      .sourceConfig;

    if (typeof sourceConfig === 'string' && sourceConfig.trim().length > 0) {
      return resolveReferencePath(dtsConfigPath, sourceConfig);
    }
  }

  throw new Error(
    [
      'Generated declaration config is missing its source config metadata:',
      `  config: ${dtsConfigPath}`,
      '  field: liminaOptions.sourceConfig',
      '  reason: Limina no longer infers source companions from source-level tsconfig*.dts.json files.',
    ].join('\n'),
  );
}

export function isBuildGraphConfigPath(configPath: string): boolean {
  return buildGraphConfigFilePattern.test(path.basename(configPath));
}

function isReservedTypeScriptConfigFile(fileName: string): boolean {
  return (
    dtsConfigFilePattern.test(fileName) ||
    buildGraphConfigFilePattern.test(fileName) ||
    baseConfigFilePattern.test(fileName) ||
    checkConfigFilePattern.test(fileName)
  );
}

export function isOrdinaryTypecheckConfigPath(configPath: string): boolean {
  const fileName = path.basename(configPath);

  return (
    tsconfigFilePattern.test(fileName) &&
    !isReservedTypeScriptConfigFile(fileName)
  );
}

export function isOrdinarySourceTypecheckConfigPath(
  configPath: string,
): boolean {
  return (
    isOrdinaryTypecheckConfigPath(configPath) &&
    !configPath.split(path.sep).includes('.limina')
  );
}

export function collectGraphProjectRouteFromRoot(options: {
  rootConfigPath: string;
  rootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): CollectGraphProjectPathsResult {
  const rootGraphConfigPath = normalizeAbsolutePath(options.rootConfigPath);
  const seen = new Set<string>();
  const orderedProjects: string[] = [];
  const problems: string[] = [];
  const rootReferences = collectReferencePathInfosForConfig(
    options.rootDir,
    rootGraphConfigPath,
    options.virtualFiles,
  );
  const queue = rootReferences.references.map((reference) => ({
    projectPath: reference.resolvedPath,
    rawReferencePath: reference.rawPath,
    referrerPath: rootGraphConfigPath,
  }));
  const formatConfigPath = (configPath: string): string =>
    toRelativePath(options.rootDir, configPath);
  const validateUserConfig = (configPath: string): void => {
    const normalizedConfigPath = normalizeAbsolutePath(configPath);

    if (
      !existsSync(normalizedConfigPath) &&
      !options.virtualFiles?.has(normalizedConfigPath)
    ) {
      return;
    }

    validateUserMaintainedLiminaTsconfigMetadata({
      configObject: readJsonConfigFile(
        options.rootDir,
        normalizedConfigPath,
        options.virtualFiles,
      ),
      configPath: normalizedConfigPath,
    });
  };

  validateUserConfig(rootGraphConfigPath);

  problems.push(...rootReferences.problems);

  if (
    !isBuildGraphConfigPath(rootGraphConfigPath) &&
    !isDtsConfigPath(rootGraphConfigPath)
  ) {
    problems.push(
      [
        'Invalid checker entry config:',
        `  config: ${formatConfigPath(rootGraphConfigPath)}`,
        '  reason: checker entries should point to a tsconfig*.build.json graph aggregator or a direct tsconfig*.dts.json declaration leaf.',
      ].join('\n'),
    );
  }

  if (isDtsConfigPath(rootGraphConfigPath)) {
    seen.add(rootGraphConfigPath);
    orderedProjects.push(rootGraphConfigPath);
  }

  for (const { projectPath } of queue) {
    seen.add(projectPath);
  }

  for (const { projectPath, rawReferencePath, referrerPath } of queue) {
    if (!projectPath) {
      continue;
    }

    if (
      !existsSync(projectPath) &&
      !options.virtualFiles?.has(normalizeAbsolutePath(projectPath))
    ) {
      problems.push(
        [
          'Checker entry references a missing tsconfig:',
          `  from: ${formatConfigPath(referrerPath)}`,
          `  reference: ${rawReferencePath}`,
          `  resolved: ${formatConfigPath(projectPath)}`,
          '  reason: every project reference reachable from a checker entry must point to an existing tsconfig file or directory with tsconfig.json.',
        ].join('\n'),
      );
      continue;
    }

    validateUserConfig(projectPath);

    if (!isBuildGraphConfigPath(projectPath) && !isDtsConfigPath(projectPath)) {
      problems.push(
        [
          'Invalid checker entry reference:',
          `  from: ${formatConfigPath(referrerPath)}`,
          `  reference: ${rawReferencePath}`,
          `  resolved: ${formatConfigPath(projectPath)}`,
          '  reason: checker entries may only reach tsconfig*.build.json graph aggregators and tsconfig*.dts.json declaration leaves.',
        ].join('\n'),
      );
      continue;
    }

    orderedProjects.push(projectPath);

    const referenceCollection = collectReferencePathInfosForConfig(
      options.rootDir,
      projectPath,
      options.virtualFiles,
    );

    problems.push(...referenceCollection.problems);

    for (const reference of referenceCollection.references) {
      const referencePath = reference.resolvedPath;

      if (seen.has(referencePath)) {
        continue;
      }

      seen.add(referencePath);
      queue.push({
        projectPath: referencePath,
        rawReferencePath: reference.rawPath,
        referrerPath: projectPath,
      });
    }
  }

  return {
    problems,
    projectPaths: orderedProjects,
  };
}

export function collectGraphProjectRoutes(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectCheckerGraphProjectRoutesResult {
  return projectGraphProjectRoutes(
    config,
    collectCheckerRouteSnapshot(config, generatedGraph),
  );
}

export function collectCheckerRouteSnapshot(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
  metrics?: CheckerRouteMetricsRecorder,
): CheckerRouteSnapshotCollection {
  const checkers = generatedGraph?.checkers ?? getActiveCheckers(config);
  const snapshots: CheckerRouteSnapshot[] = [];
  const traversals = new Map<string, CheckerRouteTraversalSnapshot>();

  for (const checker of checkers) {
    const rootConfigPath = generatedGraph?.checkerEntries.get(checker.name);
    const supportsSourceGraph = Boolean(
      getCheckerAdapter(checker.preset)?.sourceGraph,
    );

    if (!rootConfigPath) {
      snapshots.push(
        createCheckerRouteSnapshot({
          checker,
          entryAvailability: 'missing-entry',
          supportsSourceGraph,
        }),
      );
      continue;
    }

    const normalizedRootConfigPath = normalizeAbsolutePath(rootConfigPath);
    if (
      !existsSync(rootConfigPath) &&
      !generatedGraph?.generatedFiles.has(normalizedRootConfigPath)
    ) {
      snapshots.push(
        createCheckerRouteSnapshot({
          checker,
          entryAvailability: 'missing-config',
          normalizedRootConfigPath,
          rootConfigPath,
          supportsSourceGraph,
        }),
      );
      continue;
    }

    let traversal = traversals.get(normalizedRootConfigPath);
    if (traversal) {
      metrics?.record({
        kind: 'cache-hit',
        name: 'checker-route-traversal',
        provider: 'checker-route-snapshot',
      });
    } else {
      const result = collectGraphProjectRouteFromRoot({
        rootConfigPath: normalizedRootConfigPath,
        rootDir: config.rootDir,
        virtualFiles: generatedGraph?.generatedFiles,
      });
      traversal = Object.freeze({
        normalizedRootConfigPath,
        problems: Object.freeze([...result.problems]),
        projectPaths: Object.freeze([...result.projectPaths]),
      });
      traversals.set(normalizedRootConfigPath, traversal);
      metrics?.record({
        kind: 'traversal',
        name: 'checker-route-traversal',
        provider: 'checker-route-snapshot',
      });
    }

    snapshots.push(
      createCheckerRouteSnapshot({
        checker,
        entryAvailability: 'available',
        normalizedRootConfigPath,
        rootConfigPath,
        supportsSourceGraph,
        traversal,
      }),
    );
  }

  metrics?.record({
    count: snapshots.length,
    kind: 'checker-snapshot',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
  metrics?.record({
    count: traversals.size,
    kind: 'unique-entry-root',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });

  return Object.freeze({
    checkers: Object.freeze(snapshots),
    generatedFiles: generatedGraph?.generatedFiles,
    metrics,
    traversalCount: traversals.size,
    uniqueValidCheckerEntryRoots: traversals.size,
  });
}

function createCheckerRouteSnapshot(options: {
  checker: ResolvedCheckerConfig;
  entryAvailability: CheckerEntryAvailability;
  normalizedRootConfigPath?: string;
  rootConfigPath?: string;
  supportsSourceGraph: boolean;
  traversal?: CheckerRouteTraversalSnapshot;
}): CheckerRouteSnapshot {
  return Object.freeze({
    checkerName: options.checker.name,
    checkerPreset: options.checker.preset,
    entryAvailability: options.entryAvailability,
    extensions: Object.freeze([...options.checker.extensions]),
    normalizedRootConfigPath: options.normalizedRootConfigPath,
    rootConfigPath: options.rootConfigPath,
    supportsSourceGraph: options.supportsSourceGraph,
    traversal: options.traversal,
  });
}

function projectCheckerRoutes(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
  projection: 'entry' | 'graph',
): CollectCheckerGraphProjectRoutesResult {
  const routes: CheckerGraphProjectRoute[] = [];
  const problems: string[] = [];

  for (const checker of snapshot.checkers) {
    if (projection === 'graph' && !checker.supportsSourceGraph) {
      continue;
    }

    if (checker.entryAvailability === 'missing-entry') {
      problems.push(
        projection === 'graph'
          ? [
              'Missing generated checker graph entry:',
              `  checker: ${checker.checkerName}`,
              '  reason: run limina graph prepare before collecting checker graph routes.',
            ].join('\n')
          : [
              'Missing generated checker entry:',
              `  checker: ${checker.checkerName}`,
              '  reason: run limina graph prepare before collecting checker entry routes.',
            ].join('\n'),
      );
      continue;
    }

    if (checker.entryAvailability === 'missing-config') {
      problems.push(
        projection === 'graph'
          ? [
              'Checker graph entry references a missing tsconfig:',
              `  checker: ${checker.checkerName}`,
              `  config: ${toRelativePath(config.rootDir, checker.rootConfigPath ?? '')}`,
            ].join('\n')
          : [
              'Checker entry references a missing tsconfig:',
              `  checker: ${checker.checkerName}`,
              `  config: ${toRelativePath(config.rootDir, checker.rootConfigPath ?? '')}`,
            ].join('\n'),
      );
      continue;
    }

    const traversal = checker.traversal;
    if (!checker.rootConfigPath || !traversal) continue;
    problems.push(...traversal.problems);
    routes.push({
      checkerName: checker.checkerName,
      checkerPreset: checker.checkerPreset,
      extensions: [...checker.extensions],
      projectPaths: [...traversal.projectPaths],
      rootConfigPath: checker.rootConfigPath,
    });
  }

  return {
    problems,
    routes,
  };
}

export function projectGraphProjectRoutes(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
): CollectCheckerGraphProjectRoutesResult {
  snapshot.metrics?.record({
    kind: 'graph-route',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
  return projectCheckerRoutes(config, snapshot, 'graph');
}

export function collectCheckerEntryProjectRoutes(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectCheckerGraphProjectRoutesResult {
  return projectCheckerEntryProjectRoutes(
    config,
    collectCheckerRouteSnapshot(config, generatedGraph),
  );
}

export function projectCheckerEntryProjectRoutes(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
): CollectCheckerGraphProjectRoutesResult {
  snapshot.metrics?.record({
    kind: 'entry-route',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
  return projectCheckerRoutes(config, snapshot, 'entry');
}

export function collectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectSourceGraphProjectExtensionsResult {
  return projectSourceGraphProjectExtensions(
    config,
    collectCheckerRouteSnapshot(config, generatedGraph),
  );
}

export function projectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
): CollectSourceGraphProjectExtensionsResult {
  snapshot.metrics?.record({
    kind: 'source-extension',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
  const routeCollection = projectCheckerRoutes(config, snapshot, 'graph');
  const projectContextsByPath = new Map<string, CheckerProjectParseContext>();
  const projectExtensionsByPath = new Map<string, string[]>();
  for (const route of routeCollection.routes) {
    for (const projectPath of route.projectPaths) {
      if (!isDtsConfigPath(projectPath)) {
        continue;
      }

      const adapterExtensions = resolveCheckerProjectExtensions({
        configPath: projectPath,
        preset: route.checkerPreset,
        projectRootDir: config.rootDir,
        virtualFiles: snapshot.generatedFiles,
      });
      const routeExtensions = normalizeExtensions(adapterExtensions);
      const projectContext = projectContextsByPath.get(projectPath) ?? {
        checkerPresets: [],
        extensions: [],
      };

      projectContextsByPath.set(projectPath, {
        checkerPresets: uniqueValues([
          ...projectContext.checkerPresets,
          route.checkerPreset,
        ]),
        extensions: normalizeExtensions([
          ...projectContext.extensions,
          ...routeExtensions,
        ]),
      });
      projectExtensionsByPath.set(
        projectPath,
        normalizeExtensions([
          ...(projectExtensionsByPath.get(projectPath) ?? []),
          ...routeExtensions,
        ]),
      );
    }
  }

  return {
    problems: routeCollection.problems,
    projectContextsByPath,
    projectExtensionsByPath,
  };
}

export function formatReferences(
  rootDir: string,
  references: Set<string>,
): string {
  if (references.size === 0) {
    return '(none)';
  }

  return [...references]
    .sort()
    .map((value) => toRelativePath(rootDir, value))
    .join(', ');
}
