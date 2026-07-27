import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectReferencePathInfosForConfig,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  createProjectBuildModule,
  createSolutionBuildModule,
} from './build-modules';
import {
  addSourceReferenceConfigProblems,
  isSolutionStyleTsconfig,
  readOutputOptions,
} from './generated/config-readers';
import { createGeneratedGraphStructuredError } from './problems';
import {
  getInvalidSolutionOutputProblem,
  getOutsideRegionProblem,
} from './source-config-problems';
import type { CheckerSourceConfigCollection } from './types';

interface CollectionContext {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  problems: string[];
  seenConfigs: Set<string>;
}

interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}

function isEmptyLeafConfig(configObject: JsonObject): boolean {
  const files = configObject.files;
  return (
    Array.isArray(files) &&
    files.length === 0 &&
    !Object.hasOwn(configObject, 'include')
  );
}

function rejectOutsideActivatedRegion(options: ConfigVisit): boolean {
  if (options.activatedRegions.isSourceConfigPath(options.sourceConfigPath)) {
    return false;
  }
  options.problems.push(getOutsideRegionProblem(options));
  return true;
}

function shouldSkipConfigVisit(options: ConfigVisit): boolean {
  if (rejectOutsideActivatedRegion(options)) {
    return true;
  }
  return options.seenConfigs.has(options.sourceConfigPath);
}

function registerSourceConfig(options: ConfigVisit): string {
  options.seenConfigs.add(options.sourceConfigPath);
  const packageRootDir = options.activatedRegions.findPackageForPath(
    options.sourceConfigPath,
  )!.directory;
  options.collection.packageRootBySourcePath.set(
    options.sourceConfigPath,
    packageRootDir,
  );
  return packageRootDir;
}

function isCollectibleReference(referencePath: string): boolean {
  return (
    existsSync(referencePath) &&
    isOrdinarySourceTypecheckConfigPath(referencePath)
  );
}

function collectSolutionReference(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
  referenceSourceConfigPaths: string[];
}): void {
  if (!isCollectibleReference(options.referencePath)) {
    return;
  }
  collectCheckerSourceConfigModules({
    ...options.context,
    referencedFromConfigPath: options.fromConfigPath,
    sourceConfigPath: options.referencePath,
  });
  if (
    options.context.collection.buildModulesBySourcePath.has(
      options.referencePath,
    )
  ) {
    options.referenceSourceConfigPaths.push(options.referencePath);
  }
}

function collectSolutionReferences(options: ConfigVisit): string[] {
  const references = collectReferencePathInfosForConfig(
    options.config.rootDir,
    options.sourceConfigPath,
  );
  options.problems.push(...references.problems);
  const sourceConfigPaths: string[] = [];
  for (const reference of references.references) {
    collectSolutionReference({
      context: options,
      fromConfigPath: options.sourceConfigPath,
      referencePath: reference.resolvedPath,
      referenceSourceConfigPaths: sourceConfigPaths,
    });
  }
  return uniqueSortedStrings(sourceConfigPaths);
}

function collectSolutionConfig(
  options: ConfigVisit,
  packageRootDir: string,
): void {
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
  );
  options.problems.push(...outputOptions.problems);
  if (outputOptions.outputs) {
    options.problems.push(getInvalidSolutionOutputProblem(options));
  }
  options.collection.solutionConfigPaths.add(options.sourceConfigPath);
  options.collection.buildModulesBySourcePath.set(
    options.sourceConfigPath,
    createSolutionBuildModule({
      checkerName: options.checkerName,
      packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
  );
  options.collection.solutionReferencesBySourcePath.set(
    options.sourceConfigPath,
    collectSolutionReferences(options),
  );
}

function collectLeafConfig(options: ConfigVisit, packageRootDir: string): void {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  if (isEmptyLeafConfig(configObject)) {
    return;
  }
  options.collection.projectConfigPaths.add(options.sourceConfigPath);
  options.collection.buildModulesBySourcePath.set(
    options.sourceConfigPath,
    createProjectBuildModule({
      checkerName: options.checkerName,
      packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
  );
}

function collectValidConfig(options: {
  configObject: JsonObject;
  packageRootDir: string;
  visit: ConfigVisit;
}): void {
  if (
    isSolutionStyleTsconfig(
      options.visit.sourceConfigPath,
      options.configObject,
    )
  ) {
    collectSolutionConfig(options.visit, options.packageRootDir);
    return;
  }
  const outputOptions = readOutputOptions(
    options.visit.config,
    options.visit.sourceConfigPath,
  );
  options.visit.problems.push(...outputOptions.problems);
  collectLeafConfig(options.visit, options.packageRootDir);
}

function hasInvalidReferences(
  sourceConfigPath: string,
  configObject: JsonObject,
): boolean {
  return (
    Object.hasOwn(configObject, 'references') &&
    !isSolutionStyleTsconfig(sourceConfigPath, configObject)
  );
}

function collectCheckerSourceConfigModules(options: ConfigVisit): void {
  if (shouldSkipConfigVisit(options)) {
    return;
  }
  const packageRootDir = registerSourceConfig(options);
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  validateUserMaintainedLiminaTsconfigMetadata({
    configObject,
    configPath: options.sourceConfigPath,
  });
  if (hasInvalidReferences(options.sourceConfigPath, configObject)) {
    addSourceReferenceConfigProblems({
      config: options.config,
      problems: options.problems,
      sourceConfigPath: options.sourceConfigPath,
    });
    return;
  }
  collectValidConfig({ configObject, packageRootDir, visit: options });
}

function createEmptyCollection(
  entryConfigPaths: readonly string[],
): CheckerSourceConfigCollection {
  const normalizedEntries = uniqueSortedStrings(
    entryConfigPaths.map(normalizeAbsolutePath),
  );
  return {
    buildModulesBySourcePath: new Map(),
    entryConfigPaths: new Set(normalizedEntries),
    packageRootBySourcePath: new Map(),
    projectConfigPaths: new Set(),
    rootConfigPaths: [],
    solutionConfigPaths: new Set(),
    solutionReferencesBySourcePath: new Map(),
  };
}

export function collectCheckerSourceConfigs(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  config: ResolvedLiminaConfig;
  entryConfigPaths: readonly string[];
}): CheckerSourceConfigCollection {
  const collection = createEmptyCollection(options.entryConfigPaths);
  const problems: string[] = [];
  const context: CollectionContext = {
    ...options,
    collection,
    problems,
    seenConfigs: new Set(),
  };
  for (const sourceConfigPath of collection.entryConfigPaths) {
    collectCheckerSourceConfigModules({ ...context, sourceConfigPath });
  }
  if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to collect checker source configs.',
      problems,
    });
  }
  collection.rootConfigPaths = [...collection.entryConfigPaths].filter(
    (sourcePath) => collection.buildModulesBySourcePath.has(sourcePath),
  );
  return collection;
}

export function collectAutoSourceConfigModules(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  problems: string[];
}): void {
  collectCheckerSourceConfigModules({
    activatedRegions: options.activatedRegions,
    checkerName: '__auto__',
    collection: options.collection,
    config: options.config,
    problems: options.problems,
    seenConfigs: new Set(),
    sourceConfigPath: options.entryConfigPath,
  });
}

export function createEmptySourceConfigCollection(
  entryConfigPaths: readonly string[],
): CheckerSourceConfigCollection {
  return createEmptyCollection(entryConfigPaths);
}
