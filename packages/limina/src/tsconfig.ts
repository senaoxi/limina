import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { getCheckerAdapter, normalizeExtensions } from './checkers';
import { getActiveCheckers, type ResolvedLiminaConfig } from './config';
import { normalizeAbsolutePath, toRelativePath } from './utils/path';

export type JsonObject = Record<string, unknown>;

const dtsConfigFilePattern = /^tsconfig(?:\..+)?\.dts\.json$/u;
const buildGraphConfigFilePattern = /^tsconfig(?:\..+)?\.build\.json$/u;
const generatedConfigFilePattern =
  /^tsconfig(?:\..+)?\.paths\.generated\.json$/u;
const baseConfigFilePattern = /^tsconfig(?:\..+)?\.base\.json$/u;
const checkConfigFilePattern = /^tsconfig(?:\..+)?\.check\.json$/u;
const tsconfigFilePattern = /^tsconfig(?:\..+)?\.json$/u;

interface ReferencePathInfo {
  rawPath: string;
  resolvedPath: string;
}

interface ReferencePathCollection {
  problems: string[];
  references: ReferencePathInfo[];
}

export interface CollectGraphProjectPathsResult {
  problems: string[];
  projectPaths: string[];
}

export interface CheckerGraphProjectRoute {
  checkerName: string;
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
  projectExtensionsByPath: Map<string, string[]>;
}

export function createFormatHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => '\n',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function createExtensionPattern(extensions: string[]): RegExp {
  if (extensions.length === 0) {
    return /(?!)/u;
  }

  return new RegExp(
    `(?:${extensions
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')})$`,
    'u',
  );
}

export function createExtraFileExtensions(
  extensions: string[],
): ts.FileExtensionInfo[] {
  const nativeExtensions = new Set([
    '.ts',
    '.tsx',
    '.cts',
    '.mts',
    '.d.ts',
    '.d.cts',
    '.d.mts',
    '.js',
    '.jsx',
    '.cjs',
    '.mjs',
    '.json',
  ]);

  return extensions
    .filter((extension) => !nativeExtensions.has(extension))
    .map((extension) => ({
      extension,
      isMixedContent: true,
      scriptKind: ts.ScriptKind.Deferred,
    }));
}

function readJsonConfigFile(rootDir: string, configPath: string): JsonObject {
  const result = ts.readConfigFile(configPath, ts.sys.readFile);

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

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function collectReferencePathInfosForConfig(
  rootDir: string,
  configPath: string,
): ReferencePathCollection {
  const configObject = readJsonConfigFile(rootDir, configPath);

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

  references.forEach((reference, index) => {
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
      return;
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
      return;
    }

    referenceInfos.push({
      rawPath: pathValue,
      resolvedPath: resolveReferencePath(configPath, pathValue),
    });
  });

  return {
    problems,
    references: referenceInfos,
  };
}

export function isDtsConfigPath(configPath: string): boolean {
  return dtsConfigFilePattern.test(path.basename(configPath));
}

export function getDtsCompanionConfigPath(dtsConfigPath: string): string {
  const directory = path.dirname(dtsConfigPath);
  const fileName = path.basename(dtsConfigPath);
  const companionFileName =
    fileName === 'tsconfig.dts.json'
      ? 'tsconfig.json'
      : fileName.replace(/\.dts\.json$/u, '.json');
  const scopedCompanionPath = normalizeAbsolutePath(
    path.join(directory, companionFileName),
  );

  if (
    companionFileName === 'tsconfig.json' ||
    existsSync(scopedCompanionPath)
  ) {
    return scopedCompanionPath;
  }

  return normalizeAbsolutePath(path.join(directory, 'tsconfig.json'));
}

export function isBuildGraphConfigPath(configPath: string): boolean {
  return buildGraphConfigFilePattern.test(path.basename(configPath));
}

function isReservedTypeScriptConfigFile(fileName: string): boolean {
  return (
    dtsConfigFilePattern.test(fileName) ||
    buildGraphConfigFilePattern.test(fileName) ||
    generatedConfigFilePattern.test(fileName) ||
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

export function collectGraphProjectRouteFromRoot(options: {
  rootConfigPath: string;
  rootDir: string;
}): CollectGraphProjectPathsResult {
  const rootGraphConfigPath = normalizeAbsolutePath(options.rootConfigPath);
  const seen = new Set<string>();
  const orderedProjects: string[] = [];
  const problems: string[] = [];
  const rootReferences = collectReferencePathInfosForConfig(
    options.rootDir,
    rootGraphConfigPath,
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

    if (!existsSync(projectPath)) {
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
): CollectCheckerGraphProjectRoutesResult {
  const routes: CheckerGraphProjectRoute[] = [];
  const problems: string[] = [];

  for (const checker of getActiveCheckers(config)) {
    const adapter = getCheckerAdapter(checker.preset);

    if (!adapter?.sourceGraph) {
      continue;
    }

    const rootConfigPath = resolveProjectConfigPath(
      config.rootDir,
      checker.entry,
    );

    if (!existsSync(rootConfigPath)) {
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
    });

    problems.push(...routeCollection.problems);
    routes.push({
      checkerName: checker.name,
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
): CollectCheckerGraphProjectRoutesResult {
  const routes: CheckerGraphProjectRoute[] = [];
  const problems: string[] = [];

  for (const checker of getActiveCheckers(config)) {
    const rootConfigPath = resolveProjectConfigPath(
      config.rootDir,
      checker.entry,
    );

    if (!existsSync(rootConfigPath)) {
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
    });

    problems.push(...routeCollection.problems);
    routes.push({
      checkerName: checker.name,
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

export function collectGraphProjectRoute(
  config: ResolvedLiminaConfig,
): CollectGraphProjectPathsResult {
  const routeCollection = collectGraphProjectRoutes(config);

  return {
    problems: routeCollection.problems,
    projectPaths: [
      ...new Set(routeCollection.routes.flatMap((route) => route.projectPaths)),
    ].sort(),
  };
}

export function collectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
): CollectSourceGraphProjectExtensionsResult {
  const routeCollection = collectGraphProjectRoutes(config);
  const projectExtensionsByPath = new Map<string, string[]>();
  const typeScriptExtensions =
    getCheckerAdapter('tsc')?.defaultExtensions ?? [];

  for (const route of routeCollection.routes) {
    const routeExtensions = normalizeExtensions([
      ...typeScriptExtensions,
      ...route.extensions,
    ]);

    for (const projectPath of route.projectPaths) {
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
    projectExtensionsByPath,
  };
}

export function collectGraphProjectPaths(
  config: ResolvedLiminaConfig,
): string[] {
  return collectGraphProjectRoute(config).projectPaths;
}

export function parseProjectFileNames(
  config: ResolvedLiminaConfig,
  configPath: string,
  pattern: RegExp = /\.(?:[cm]?tsx?|d\.[cm]?ts|json)$/u,
): string[] {
  return parseProjectFileNamesForExtensions(config, configPath, [], pattern);
}

export function parseProjectFileNamesForExtensions(
  config: ResolvedLiminaConfig,
  configPath: string,
  extensions: string[],
  pattern: RegExp = createExtensionPattern(extensions),
): string[] {
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

  return parsed.fileNames
    .filter((fileName) => pattern.test(fileName))
    .map(normalizeAbsolutePath);
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
