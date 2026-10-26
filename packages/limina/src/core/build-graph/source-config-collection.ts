import {
  type CheckerProjectConfigCache,
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
  type ParsedCheckerProjectConfig,
} from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import {
  collectReferencePathInfosForConfig,
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import type ts from 'typescript';
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
import { capabilityDiscoveryExtensions } from './generated/file-extensions';
import { createGeneratedGraphStructuredError } from './problems';
import type { SourceConfigDiscovery } from './source-config-discovery';
import type { CheckerSourceConfigCollection } from './types';

interface CollectionContext {
  onInputError?: (configPath: string, error: Error) => void;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaInputs;
  discoveryExtensions?: string[];
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  seenConfigs: Set<string>;
  sourceConfigInspector?: SourceConfigInspector;
}

type SourceConfigInspector = (options: {
  configObject: JsonObject;
  sourceConfigPath: string;
}) => void;

interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}

interface SourceConfigAnalysis {
  configClosure: ParsedCheckerProjectConfig['configClosure'];
  configObject: JsonObject;
  fileNames: string[];
  options: ts.CompilerOptions;
}

interface CollectCheckerSourceConfigsOptions {
  onProblems?: (problems: string[]) => void;
  sourceDiscovery?: SourceConfigDiscovery;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  config: ResolvedLiminaInputs;
  discoveryExtensions?: string[];
  entryConfigPaths: readonly string[];
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  projectConfigCache?: CheckerProjectConfigCache;
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
  collection.sourceDiscovery = options.sourceDiscovery;
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
  options.collection.sourceDiscovery?.begin(options.sourceConfigPath);
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
    options.context.onInputError?.(
      options.fromConfigPath,
      new TsconfigInputError(
        `Solution membership target is missing or is not an ordinary config: ${options.referencePath}`,
      ),
    );
    return;
  }
  const targetChecker = resolveReferenceOwner(options);
  collectOwnedSolutionReference({ ...options, targetChecker });
}

function collectSolutionReferences(options: ConfigVisit): string[] {
  const references = collectReferencePathInfosForConfig(
    options.config.rootDir,
    options.sourceConfigPath,
    options.config.virtualFiles,
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
  packageRootDirectory: string,
  configObject: JsonObject,
): void {
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
    configObject,
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
    collectSolutionReferences(options),
  );
}

function collectLeafConfig(
  options: ConfigVisit,
  packageRootDirectory: string,
  analysis: SourceConfigAnalysis,
): void {
  if (
    analysis.fileNames.length === 0 &&
    !Object.hasOwn(analysis.configObject, 'include')
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
  const isSolution = isLiminaSolutionConfig({
    configObject: options.analysis.configObject,
    configPath: options.visit.sourceConfigPath,
    fileNames: options.analysis.fileNames,
  });
  options.visit.collection.sourceDiscovery?.parsed(
    options.visit.sourceConfigPath,
    options.analysis.fileNames,
    { isSolution, basis: options.analysis.configClosure },
  );
  if (isSolution) {
    collectSolutionConfig(
      options.visit,
      options.packageRootDir,
      options.analysis.configObject,
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

function hasInvalidSourceReferences(
  configPath: string,
  analysis: SourceConfigAnalysis,
): boolean {
  return (
    Object.hasOwn(analysis.configObject, 'references') &&
    !isLiminaSolutionConfig({
      configObject: analysis.configObject,
      configPath,
      fileNames: analysis.fileNames,
    })
  );
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
  if (analysis === null) return;
  validateUserMaintainedLiminaTsconfigMetadata({
    configObject: analysis.configObject,
    configPath: options.options.sourceConfigPath,
    rootDir: options.options.config.rootDir,
  });
  if (hasInvalidSourceReferences(options.options.sourceConfigPath, analysis)) {
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

function resolveDiscoveryExtensions(options: ConfigVisit): string[] {
  return (
    options.discoveryExtensions ??
    normalizeExtensions(capabilityDiscoveryExtensions)
  );
}

function isInspectionAddedProblems(options: {
  configObject: SourceConfigAnalysis['configObject'];
  problemCount: number;
  visit: ConfigVisit;
}): boolean {
  if (!options.visit.sourceConfigInspector) return false;
  options.visit.sourceConfigInspector({
    configObject: options.configObject,
    sourceConfigPath: options.visit.sourceConfigPath,
  });
  return options.visit.problems.length > options.problemCount;
}

function parseSourceConfig(options: ConfigVisit): SourceConfigAnalysis | null {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  if (
    isInspectionAddedProblems({
      configObject,
      problemCount: options.problems.length,
      visit: options,
    })
  ) {
    return null;
  }
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.sourceConfigPath,
    context: {
      checkerPresets: [options.checkerPreset],
      extensions: resolveDiscoveryExtensions(options),
    },
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  return {
    configObject,
    configClosure: parsed.configClosure,
    fileNames: parsed.fileNames,
    options: parsed.options,
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
