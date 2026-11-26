import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import {
  collectReferencePathInfosFromConfigObject,
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import { TsconfigInputError } from '../tsconfig/config-paths';
import { getWorkspaceRegionBoundaryExclusionReason } from '../workspace/regions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  createProjectBuildModule,
  createSolutionBuildModule,
} from './build-modules';
import {
  addSourceReferenceConfigProblems,
  readOutputOptions,
} from './generated/config-readers';
import { createGeneratedGraphStructuredError } from './problems';
import type { CheckerSourceConfigCollection } from './types';

interface CollectionContext {
  onInputError?: (configPath: string, error: Error) => void;
  onInvalidReference?: (configPath: string, error: Error) => void;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaInputs;
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  problems: string[];
  selectedLeafConfigPaths?: ReadonlySet<string>;
  seenConfigs: Set<string>;
  sourceConfigParser: (
    configPath: string,
    referencedFromConfigPath: string | undefined,
    configObject: JsonObject,
  ) => { fileNames?: readonly string[] };
}

interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}

interface SourceConfigAnalysis {
  configObject: JsonObject;
  fileNames?: readonly string[];
  isSolution: boolean;
}

interface CollectCheckerSourceConfigsOptions {
  sourceConfigParser: CollectionContext['sourceConfigParser'];
  onInputError?: (configPath: string, error: Error) => void;
  onProblems?: (problems: string[]) => void;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  config: ResolvedLiminaInputs;
  entryConfigPaths: readonly string[];
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  selectedLeafConfigPaths?: ReadonlySet<string>;
}

export function createEmptySourceConfigCollection(
  entryConfigPaths: readonly string[],
): CheckerSourceConfigCollection {
  const normalizedEntries = uniqueSortedStrings(
    entryConfigPaths.map(normalizeAbsolutePath),
  );
  return {
    buildModulesBySourcePath: new Map(),
    crossCheckerReferences: [],
    entryConfigPaths: new Set(normalizedEntries),
    incompleteTopology: false,
    packageRootBySourcePath: new Map(),
    projectConfigPaths: new Set(),
    rootConfigPaths: [],
    solutionConfigPaths: new Set(),
    solutionReferencesBySourcePath: new Map(),
  };
}

function assertCollectionSucceeded(options: {
  context: CollectionContext;
}): void {
  if (options.context.problems.length === 0) return;
  throw createGeneratedGraphStructuredError({
    config: options.context.config,
    fallback: 'Failed to collect checker source configs.',
    problems: options.context.problems,
  });
}

export function collectCheckerSourceConfigs(
  options: CollectCheckerSourceConfigsOptions,
): CheckerSourceConfigCollection {
  const collection = createEmptySourceConfigCollection(
    options.entryConfigPaths,
  );
  const context: CollectionContext = {
    ...options,
    collection,
    problems: [],
    seenConfigs: new Set(),
  };
  for (const sourceConfigPath of collection.entryConfigPaths) {
    collectCheckerSourceConfigModules({ ...context, sourceConfigPath });
  }
  if (options.onProblems) options.onProblems(context.problems);
  else assertCollectionSucceeded({ context });
  collection.rootConfigPaths = [...collection.entryConfigPaths].filter(
    (sourcePath) => collection.buildModulesBySourcePath.has(sourcePath),
  );
  return collection;
}

function isRejectOutsideActivatedRegion(options: ConfigVisit): boolean {
  if (options.activatedRegions.isSourceConfigPath(options.sourceConfigPath)) {
    return false;
  }
  options.collection.incompleteTopology = true;
  options.problems.push(getOutsideRegionProblem(options));
  return true;
}

function shouldSkipConfigVisit(options: ConfigVisit): boolean {
  return (
    isRejectOutsideActivatedRegion(options) ||
    options.seenConfigs.has(options.sourceConfigPath)
  );
}

function registerSourceConfig(options: ConfigVisit): string {
  options.seenConfigs.add(options.sourceConfigPath);
  const packageRootDirectory = options.activatedRegions.findPackageForPath(
    options.sourceConfigPath,
  )!.directory;
  options.collection.packageRootBySourcePath.set(
    options.sourceConfigPath,
    packageRootDirectory,
  );
  return packageRootDirectory;
}

function isCollectibleReference(
  referencePath: string,
  rootDirectory: string,
): boolean {
  return (
    existsSync(referencePath) &&
    isOrdinarySourceTypecheckConfigPath(referencePath, rootDirectory)
  );
}

function collectOwnedSolutionReference(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
  referenceSourceConfigPaths: string[];
  targetChecker: CollectionContext['checkerName'];
}): void {
  if (options.targetChecker !== options.context.checkerName) {
    recordCrossCheckerReference(options);
    options.referenceSourceConfigPaths.push(options.referencePath);
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

function collectSolutionReference(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
  referenceSourceConfigPaths: string[];
}): void {
  if (
    !isCollectibleReference(
      options.referencePath,
      options.context.config.rootDir,
    )
  ) {
    const { collection, config, onInvalidReference, problems } =
      options.context;
    collection.incompleteTopology = true;
    const reason =
      'Solution membership target is missing or is not an ordinary config';
    if (onInvalidReference) {
      onInvalidReference(
        options.fromConfigPath,
        new TsconfigInputError(`${reason}: ${options.referencePath}`),
      );
    } else {
      problems.push(
        [
          `Invalid solution membership target ${toRelativePath(config.rootDir, options.referencePath)}`,
          `  config: ${toRelativePath(config.rootDir, options.fromConfigPath)}`,
          '  field: references',
          `  reason: ${reason}.`,
        ].join('\n'),
      );
    }
    return;
  }
  const targetChecker = resolveReferenceOwner(options);
  collectOwnedSolutionReference({ ...options, targetChecker });
}

function collectSolutionReferences(
  options: ConfigVisit,
  analysis: SourceConfigAnalysis,
): string[] {
  const raw = collectReferencePathInfosFromConfigObject(
    options.config.rootDir,
    options.sourceConfigPath,
    analysis.configObject,
  );
  if (raw.problems.length > 0) options.collection.incompleteTopology = true;
  options.problems.push(...raw.problems);
  const sourceConfigPaths: string[] = [];
  for (const reference of raw.references) {
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
  packageRootDirectory: string,
  analysis: SourceConfigAnalysis,
): void {
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
    analysis.configObject,
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
      packageRootDir: packageRootDirectory,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
  );
  options.collection.solutionReferencesBySourcePath.set(
    options.sourceConfigPath,
    collectSolutionReferences(options, analysis),
  );
}

function collectLeafConfig(
  options: ConfigVisit,
  packageRootDirectory: string,
  analysis: SourceConfigAnalysis,
): void {
  if (
    analysis.fileNames?.length === 0 &&
    !Object.hasOwn(analysis.configObject, 'include') &&
    !options.selectedLeafConfigPaths?.has(options.sourceConfigPath)
  ) {
    return;
  }
  options.collection.projectConfigPaths.add(options.sourceConfigPath);
  options.collection.buildModulesBySourcePath.set(
    options.sourceConfigPath,
    createProjectBuildModule({
      checkerName: options.checkerName,
      packageRootDir: packageRootDirectory,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
  );
}

function collectValidConfig(options: {
  analysis: SourceConfigAnalysis;
  packageRootDir: string;
  visit: ConfigVisit;
}): void {
  if (options.analysis.isSolution) {
    collectSolutionConfig(
      options.visit,
      options.packageRootDir,
      options.analysis,
    );
    return;
  }
  const outputOptions = readOutputOptions(
    options.visit.config,
    options.visit.sourceConfigPath,
    options.analysis.configObject,
  );
  options.visit.problems.push(...outputOptions.problems);
  collectLeafConfig(options.visit, options.packageRootDir, options.analysis);
}

export function collectCheckerSourceConfigModules(options: ConfigVisit): void {
  if (shouldSkipConfigVisit(options)) {
    return;
  }
  const packageRootDirectory = registerSourceConfig(options);
  try {
    collectParsedSourceConfig({
      options,
      packageRootDir: packageRootDirectory,
    });
  } catch (error) {
    reportInputError(options, error);
  }
}

function collectParsedSourceConfig(options: {
  options: ConfigVisit;
  packageRootDir: string;
}): void {
  const analysis = parseSourceConfig(options.options);
  validateUserMaintainedLiminaTsconfigMetadata({
    configObject: analysis.configObject,
    configPath: options.options.sourceConfigPath,
    rootDir: options.options.config.rootDir,
  });
  if (
    !analysis.isSolution &&
    Object.hasOwn(analysis.configObject, 'references')
  ) {
    addSourceReferenceConfigProblems({
      config: options.options.config,
      configObject: analysis.configObject,
      problems: options.options.problems,
      sourceConfigPath: options.options.sourceConfigPath,
    });
  }
  collectValidConfig({
    analysis,
    packageRootDir: options.packageRootDir,
    visit: options.options,
  });
}

function isConfigInputError(error: unknown): error is Error {
  return (
    error instanceof TypeScriptConfigInputError ||
    error instanceof TsconfigInputError
  );
}

function reportInputError(options: ConfigVisit, error: unknown): void {
  if (!options.onInputError) throw error;
  if (!isConfigInputError(error)) throw error;
  options.onInputError(options.sourceConfigPath, error);
}

function parseSourceConfig(options: ConfigVisit): SourceConfigAnalysis {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  const { fileNames } = options.sourceConfigParser(
    options.sourceConfigPath,
    options.referencedFromConfigPath,
    configObject,
  );
  return {
    configObject,
    fileNames,
    isSolution:
      fileNames !== undefined &&
      isLiminaSolutionConfig({
        configObject,
        configPath: options.sourceConfigPath,
        fileNames,
      }),
  };
}

function getConfigLines(options: {
  config: ResolvedLiminaInputs;
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}): string[] {
  if (!options.referencedFromConfigPath) {
    return [
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    ];
  }
  return [
    `  from config: ${toRelativePath(options.config.rootDir, options.referencedFromConfigPath)}`,
    `  referenced config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
  ];
}

function getBoundaryLines(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  sourceConfigPath: string;
}): string[] {
  const boundary = options.activatedRegions.findBoundaryForPath(
    options.sourceConfigPath,
  );
  if (!boundary) {
    return [
      '  reason: the referenced config is not owned by any current-run activated workspace package.',
    ];
  }

  const reason = getWorkspaceRegionBoundaryExclusionReason(boundary);
  const reasonLines = reason ? [`  boundary exclusion reason: ${reason}`] : [];
  return [
    `  boundary kind: ${boundary.kind}`,
    `  boundary root: ${toRelativePath(options.config.rootDir, boundary.rootDir)}`,
    ...reasonLines,
    '  reason: the referenced config is outside the current activated workspace package region.',
  ];
}

function getOutsideRegionProblem(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  config: ResolvedLiminaInputs;
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}): string {
  const heading = options.referencedFromConfigPath
    ? 'Referenced checker source config is outside activated workspace package regions:'
    : 'Checker source config is outside activated workspace package regions:';
  return [
    heading,
    `  checker: ${options.checkerName}`,
    ...getConfigLines(options),
    ...getBoundaryLines(options),
  ].join('\n');
}

function getInvalidSolutionOutputProblem(options: {
  config: ResolvedLiminaInputs;
  sourceConfigPath: string;
}): string {
  return [
    'Invalid Limina output options:',
    `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    '  field: liminaOptions.outputs',
    '  reason: liminaOptions.outputs is only allowed on ordinary source leaf configs, not TypeScript solution configs.',
    '  fix: move liminaOptions.outputs to one or more referenced source leaf tsconfigs.',
  ].join('\n');
}

function recordCrossCheckerReference(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
  targetChecker: CollectionContext['checkerName'];
}): void {
  options.context.collection.crossCheckerReferences.push({
    fromConfigPath: options.fromConfigPath,
    toChecker: options.targetChecker,
    toConfigPath: options.referencePath,
  });
}

function getExplicitReferenceOwner(options: {
  context: CollectionContext;
  referencePath: string;
}): CollectionContext['checkerName'] | undefined {
  const explicitOwners = options.context.explicitOwnerByConfigPath;
  return explicitOwners === undefined
    ? undefined
    : explicitOwners.get(options.referencePath);
}

function addInheritedOwnerConflict(options: {
  context: CollectionContext;
  fromConfigPath: string;
  inheritedOwner: CollectionContext['checkerName'];
  referencePath: string;
}): void {
  if (options.inheritedOwner === options.context.checkerName) return;
  options.context.problems.push(
    [
      'Ambiguous inherited checker ownership:',
      `  config: ${toRelativePath(options.context.config.rootDir, options.referencePath)}`,
      `  first checker: ${options.inheritedOwner}`,
      `  conflicting checker: ${options.context.checkerName}`,
      `  referenced from: ${toRelativePath(options.context.config.rootDir, options.fromConfigPath)}`,
      '  fix: assign this config directly to one build checker with scope.checkers.<checker>.include.',
    ].join('\n'),
  );
}

function inheritReferenceOwner(
  options: {
    context: CollectionContext;
    fromConfigPath: string;
    referencePath: string;
  },
  inheritedOwners: Map<string, CollectionContext['checkerName']>,
): CollectionContext['checkerName'] {
  const inheritedOwner = inheritedOwners.get(options.referencePath);
  if (inheritedOwner === undefined) {
    inheritedOwners.set(options.referencePath, options.context.checkerName);
    return options.context.checkerName;
  }
  addInheritedOwnerConflict({ ...options, inheritedOwner });
  return inheritedOwner;
}

function resolveReferenceOwner(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
}): CollectionContext['checkerName'] {
  const explicitOwner = getExplicitReferenceOwner(options);
  if (explicitOwner !== undefined) return explicitOwner;
  const inheritedOwners = options.context.inheritedOwnerByConfigPath;
  return inheritedOwners === undefined
    ? options.context.checkerName
    : inheritReferenceOwner(options, inheritedOwners);
}
