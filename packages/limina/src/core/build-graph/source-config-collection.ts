import {
  collectReferencePathInfosForConfig,
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { existsSync } from 'node:fs';
import {
  createProjectBuildModule,
  createSolutionBuildModule,
} from './build-modules';
import {
  addSourceReferenceConfigProblems,
  readOutputOptions,
} from './generated/config-readers';
import { parseSourceConfig } from './source-config-analysis';
import type {
  CollectionContext,
  ConfigVisit,
  SourceConfigAnalysis,
} from './source-config-collection-types';
import {
  getInvalidSolutionOutputProblem,
  getOutsideRegionProblem,
} from './source-config-problems';
import {
  recordCrossCheckerReference,
  resolveReferenceOwner,
} from './source-reference-ownership';

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

function isCollectibleReference(
  referencePath: string,
  rootDir: string,
): boolean {
  return (
    existsSync(referencePath) &&
    isOrdinarySourceTypecheckConfigPath(referencePath, rootDir)
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
    return;
  }
  const targetChecker = resolveReferenceOwner(options);
  collectOwnedSolutionReference({ ...options, targetChecker });
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

function collectLeafConfig(
  options: ConfigVisit,
  packageRootDir: string,
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
      packageRootDir,
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
  if (
    isLiminaSolutionConfig({
      configObject: options.analysis.configObject,
      configPath: options.visit.sourceConfigPath,
      fileNames: options.analysis.fileNames,
    })
  ) {
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
  const packageRootDir = registerSourceConfig(options);
  collectParsedSourceConfig({ options, packageRootDir });
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
    return;
  }
  collectValidConfig({
    analysis,
    packageRootDir: options.packageRootDir,
    visit: options.options,
  });
}
