import {
  type CheckerProjectParseContext,
  getCheckerAdapter,
  normalizeExtensions,
  resolveCheckerProjectExtensions,
} from '#checkers';
import type { CheckerPreset } from '#config/runner';
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

export function readJsonConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
): JsonObject {
  return readJsonConfigFile(config.rootDir, configPath);
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
  const routes: CheckerGraphProjectRoute[] = [];
  const problems: string[] = [];

  for (const checker of generatedGraph?.checkers ?? getActiveCheckers(config)) {
    const adapter = getCheckerAdapter(checker.preset);

    if (!adapter?.sourceGraph) {
      continue;
    }

    const rootConfigPath = generatedGraph?.checkerEntries.get(checker.name);

    if (!rootConfigPath) {
      problems.push(
        [
          'Missing generated checker graph entry:',
          `  checker: ${checker.name}`,
          '  reason: run limina graph prepare before collecting checker graph routes.',
        ].join('\n'),
      );
      continue;
    }

    if (
      !existsSync(rootConfigPath) &&
      !generatedGraph?.generatedFiles.has(normalizeAbsolutePath(rootConfigPath))
    ) {
      problems.push(
        [
          'Checker graph entry references a missing tsconfig:',
          `  checker: ${checker.name}`,
          `  config: ${toRelativePath(config.rootDir, rootConfigPath)}`,
        ].join('\n'),
      );
      continue;
    }

    const routeCollection = collectGraphProjectRouteFromRoot({
      rootConfigPath,
      rootDir: config.rootDir,
      virtualFiles: generatedGraph?.generatedFiles,
    });

    problems.push(...routeCollection.problems);
    routes.push({
      checkerName: checker.name,
      checkerPreset: checker.preset,
      extensions: checker.extensions,
      projectPaths: routeCollection.projectPaths,
      rootConfigPath,
    });
  }

  return {
    problems,
    routes,
  };
}

export function collectCheckerEntryProjectRoutes(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectCheckerGraphProjectRoutesResult {
  const routes: CheckerGraphProjectRoute[] = [];
  const problems: string[] = [];

  for (const checker of generatedGraph?.checkers ?? getActiveCheckers(config)) {
    const rootConfigPath = generatedGraph?.checkerEntries.get(checker.name);

    if (!rootConfigPath) {
      problems.push(
        [
          'Missing generated checker entry:',
          `  checker: ${checker.name}`,
          '  reason: run limina graph prepare before collecting checker entry routes.',
        ].join('\n'),
      );
      continue;
    }

    if (
      !existsSync(rootConfigPath) &&
      !generatedGraph?.generatedFiles.has(normalizeAbsolutePath(rootConfigPath))
    ) {
      problems.push(
        [
          'Checker entry references a missing tsconfig:',
          `  checker: ${checker.name}`,
          `  config: ${toRelativePath(config.rootDir, rootConfigPath)}`,
        ].join('\n'),
      );
      continue;
    }

    const routeCollection = collectGraphProjectRouteFromRoot({
      rootConfigPath,
      rootDir: config.rootDir,
      virtualFiles: generatedGraph?.generatedFiles,
    });

    problems.push(...routeCollection.problems);
    routes.push({
      checkerName: checker.name,
      checkerPreset: checker.preset,
      extensions: checker.extensions,
      projectPaths: routeCollection.projectPaths,
      rootConfigPath,
    });
  }

  return {
    problems,
    routes,
  };
}

export function collectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectSourceGraphProjectExtensionsResult {
  const routeCollection = collectGraphProjectRoutes(config, generatedGraph);
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
        virtualFiles: generatedGraph?.generatedFiles,
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
