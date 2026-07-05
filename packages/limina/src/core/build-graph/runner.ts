import {
  type CheckerProjectParseContext,
  getBuildCheckerSupportedExtensions,
  getCheckerAdapter,
  getCheckerExtensions,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '#checkers';
import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  collectImportsFromFile,
  createFileOwnerLookup,
  createImportAnalysisContext,
  formatImportRecordLocation,
  resolveInternalImport,
} from '#core/import-graph/context';
import {
  collectReferencePathInfosForConfig,
  createLiminaTsconfigSchemaPath,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
} from '#core/tsconfig/actions';
import {
  collectWorkspacePackages,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { uniqueSortedStrings } from '#utils/collections';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type ts from 'typescript';
import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { createTaskFailureIssue } from '../../check-reporting/snapshot';
import { resolveDeclarationProvider } from '../import-graph/declaration-provider';
import {
  createManagedOutputDeclarationLookup,
  type ManagedOutputProjectContext,
} from '../import-graph/managed-output-provider';
import {
  type GeneratedKnipPackageConfig,
  type GeneratedKnipPackageDiagnostic,
  prepareGeneratedKnipPackageConfigs,
  resolveGeneratedKnipPackageConfigs,
  resolveGeneratedKnipPackageDiagnostics,
} from './generated-knip';
import {
  addSourceReferenceConfigProblems,
  collectTypeRootCandidates,
  isDefaultSourceTsconfigPath,
  isSolutionStyleTsconfig,
  type OutputOptions,
  readGraphRules,
  readImplicitRefs,
  readOutputOptions,
  readRelativeTypeFiles,
} from './generated/config-readers';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './generated/file-extensions';
import {
  createRelativePath,
  generatedManifestPath,
  generatedRootDirName,
  generatedTsconfigDir,
  getGeneratedCheckerEntryPath,
  getGeneratedDtsConfigPath,
  getGeneratedOutDir,
  getGeneratedOutputProjectConfigPath,
  getGeneratedOutputSolutionConfigPath,
  getGeneratedOutputTsBuildInfoPath,
  getGeneratedSolutionBuildConfigPath,
  getGeneratedTsBuildInfoPath,
} from './generated/paths';
import {
  addDuplicateCheckerOwnershipProblems,
  addOverlappingCheckerEntryProblems,
  addUnsupportedSourceConfigExtensionProblems,
} from './generated/validation';

const sourceDiscoveryIgnore = [
  '**/.git/**',
  '**/.limina/**',
  '**/.tsbuild/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
];

interface GeneratedCheckerManifest {
  configToOutputBuild: Record<string, GeneratedBuildModuleManifest>;
  preset: string;
  entry: string;
  roots: string[];
  sourceToBuild: Record<string, GeneratedBuildModuleManifest>;
  sourceToDts: Record<string, string>;
  dtsToSource: Record<string, string>;
}

interface GeneratedProviderEdgeManifest {
  file: string;
  fromChecker: string;
  fromConfig: string;
  importedSpecifier: string;
  resolvedFile: string;
  toChecker: string;
  toConfig: string;
}

export interface GeneratedProviderEdge {
  file: string;
  fromChecker: string;
  fromConfigPath: string;
  importedSpecifier: string;
  resolvedFilePath: string;
  toChecker: string;
  toConfigPath: string;
}

export type GeneratedBuildModuleKind = 'project' | 'solution';

export interface GeneratedBuildModuleManifest {
  kind: GeneratedBuildModuleKind;
  path: string;
}

export interface GeneratedBuildModule {
  kind: GeneratedBuildModuleKind;
  path: string;
}

export interface GeneratedOutputDeclarationCopyContext {
  fileNames: string[];
  outDir: string;
  rootDir: string;
  sourceConfigPath: string;
}

export interface GeneratedTsconfigGraphManifest {
  version: 2;
  generatedBy: 'limina';
  checkers: Record<string, GeneratedCheckerManifest>;
  knip: {
    diagnostics: GeneratedKnipPackageDiagnostic[];
    packages: GeneratedKnipPackageConfig[];
  };
  providerEdges: GeneratedProviderEdgeManifest[];
}

export interface GeneratedTsconfigGraphResult {
  changed: boolean;
  checkers: ResolvedCheckerConfig[];
  manifestPath: string;
  checkerEntries: Map<string, string>;
  configToOutputBuild: Map<string, Map<string, GeneratedBuildModule>>;
  outputDeclarationCopies: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >;
  sourceToBuild: Map<string, Map<string, GeneratedBuildModule>>;
  sourceToDts: Map<string, Map<string, string>>;
  dtsToSource: Map<string, Map<string, string>>;
  generatedKnipConfigs: GeneratedKnipPackageConfig[];
  generatedKnipDiagnostics: GeneratedKnipPackageDiagnostic[];
  providerEdges: GeneratedProviderEdge[];
  manifest: GeneratedTsconfigGraphManifest;
}

export interface PrepareGeneratedTsconfigGraphOptions {
  importAnalysisContext?: ImportAnalysisContext;
  workspacePackagesProvider?: () => Promise<WorkspacePackage[]>;
}

interface SourceProject {
  checkerName: string;
  configPath: string;
  context: CheckerProjectParseContext;
  dtsConfigPath: string;
  fileNames: string[];
  graphRules: string[];
  ownedFileNames: string[];
  outputConfigPath: string;
  outputOptions: OutputOptions | null;
  outputReferences: Set<string>;
  options: ts.CompilerOptions;
  references: Set<string>;
}

interface SolutionProject {
  buildConfigPath: string;
  checkerName: string;
  configPath: string;
  references: Set<string>;
}

interface OutputSolutionProject {
  buildConfigPath: string;
  checkerName: string;
  configPath: string;
  references: Set<string>;
}

interface CheckerSourceConfigCollection {
  buildModulesBySourcePath: Map<string, GeneratedBuildModule>;
  entryConfigPaths: Set<string>;
  projectConfigPaths: Set<string>;
  rootConfigPaths: string[];
  solutionConfigPaths: Set<string>;
  solutionReferencesBySourcePath: Map<string, string[]>;
}

interface GeneratedGraphWriteContext {
  changed: boolean;
  expectedFiles: Set<string>;
  rootDir: string;
}

interface PreparedCheckerGraph {
  checker: ReturnType<typeof getActiveCheckers>[number];
  collection: CheckerSourceConfigCollection;
  entryPath: string;
  projects: SourceProject[];
  rootBuildPaths: string[];
  solutions: SolutionProject[];
}

interface CheckerOutputGraph {
  configToOutputBuild: Map<string, GeneratedBuildModule>;
  outputDeclarationCopies: Map<string, GeneratedOutputDeclarationCopyContext[]>;
  outputProjects: SourceProject[];
  outputSolutions: OutputSolutionProject[];
}

interface InferredProjectReferenceCollection {
  problems: string[];
  providerEdges: GeneratedProviderEdge[];
}

type AutoCheckerPreset = 'tsc' | 'vue-tsc';

interface AutoScopeProject {
  configPath: string;
  context: CheckerProjectParseContext;
  fileNames: string[];
  options: ts.CompilerOptions;
}

interface AutoScope {
  collection: CheckerSourceConfigCollection;
  entryConfigPath: string;
  projects: AutoScopeProject[];
}

function normalizeWorkspaceGlob(value: string): string {
  return toPosixPath(value.trim());
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatProblemList(problems: string[], fallback: string): string {
  return problems.join('\n\n') || fallback;
}

function findGeneratedGraphProblemLineValue(
  problem: string,
  labels: readonly string[],
): string | undefined {
  for (const line of problem.split('\n')) {
    const trimmedLine = line.trimStart();

    for (const label of labels) {
      const prefix = `${label}:`;

      if (trimmedLine.startsWith(prefix)) {
        const value = trimmedLine.slice(prefix.length).trim();

        return value || undefined;
      }
    }
  }

  return undefined;
}

function createGeneratedGraphStructuredError(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problems: readonly string[];
}): LiminaStructuredError {
  const message = formatProblemList([...options.problems], options.fallback);

  return new LiminaStructuredError(
    message,
    options.problems.map((problem) =>
      createTaskFailureIssue({
        code: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
        detailLines: problem.split('\n'),
        filePath:
          findGeneratedGraphProblemLineValue(problem, [
            'config',
            'file',
            'project',
            'source config',
          ]) ?? options.config.configPath,
        fix: 'Inspect the generated graph diagnostic, then update checker.include, tsconfig references, or generated graph configuration before rerunning `limina graph prepare`.',
        reason:
          findGeneratedGraphProblemLineValue(problem, ['reason']) ??
          options.fallback,
        rootDir: options.config.rootDir,
        task: 'graph:prepare',
        title:
          problem.split('\n')[0]?.replace(/:+$/u, '') ||
          'Generated graph preparation failed',
        verifyCommands: ['limina graph prepare'],
      }),
    ),
  );
}

function isEmptyLeafConfig(configObject: JsonObject): boolean {
  return (
    Array.isArray(configObject.files) &&
    configObject.files.length === 0 &&
    !Object.hasOwn(configObject, 'include')
  );
}

function createProjectBuildModule(options: {
  checkerName: string;
  rootDir: string;
  sourceConfigPath: string;
}): GeneratedBuildModule {
  return {
    kind: 'project',
    path: getGeneratedDtsConfigPath(options),
  };
}

function createSolutionBuildModule(options: {
  checkerName: string;
  rootDir: string;
  sourceConfigPath: string;
}): GeneratedBuildModule {
  return {
    kind: 'solution',
    path: getGeneratedSolutionBuildConfigPath(options),
  };
}

function createOutputProjectBuildModule(options: {
  checkerName: string;
  rootDir: string;
  sourceConfigPath: string;
}): GeneratedBuildModule {
  return {
    kind: 'project',
    path: getGeneratedOutputProjectConfigPath(options),
  };
}

function createOutputSolutionBuildModule(options: {
  checkerName: string;
  rootDir: string;
  sourceConfigPath: string;
}): GeneratedBuildModule {
  return {
    kind: 'solution',
    path: getGeneratedOutputSolutionConfigPath(options),
  };
}

function collectCheckerSourceConfigModules(options: {
  checkerName: string;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  excludedConfigPaths: Set<string>;
  problems: string[];
  sourceConfigPath: string;
  seenConfigs: Set<string>;
}): void {
  if (options.excludedConfigPaths.has(options.sourceConfigPath)) {
    return;
  }

  if (options.seenConfigs.has(options.sourceConfigPath)) {
    return;
  }

  options.seenConfigs.add(options.sourceConfigPath);

  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  const hasReferences = Object.hasOwn(configObject, 'references');
  const isSolutionStyleConfig = isSolutionStyleTsconfig(
    options.sourceConfigPath,
    configObject,
  );
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
  );

  options.problems.push(...outputOptions.problems);

  if (hasReferences && !isSolutionStyleConfig) {
    addSourceReferenceConfigProblems({
      config: options.config,
      problems: options.problems,
      sourceConfigPath: options.sourceConfigPath,
    });
    return;
  }

  if (isSolutionStyleConfig) {
    if (outputOptions.outputs) {
      options.problems.push(
        [
          'Invalid Limina output options:',
          `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
          '  field: liminaOptions.outputs',
          '  reason: liminaOptions.outputs is only allowed on ordinary source leaf configs, not solution-style configs.',
          '  fix: move liminaOptions.outputs to one or more referenced source leaf tsconfigs.',
        ].join('\n'),
      );
    }

    options.collection.solutionConfigPaths.add(options.sourceConfigPath);
    options.collection.buildModulesBySourcePath.set(
      options.sourceConfigPath,
      createSolutionBuildModule({
        checkerName: options.checkerName,
        rootDir: options.config.rootDir,
        sourceConfigPath: options.sourceConfigPath,
      }),
    );

    const referenceCollection = collectReferencePathInfosForConfig(
      options.config.rootDir,
      options.sourceConfigPath,
    );
    const referenceSourceConfigPaths: string[] = [];

    options.problems.push(...referenceCollection.problems);

    for (const reference of referenceCollection.references) {
      const referencePath = reference.resolvedPath;

      if (
        !existsSync(referencePath) ||
        !isOrdinarySourceTypecheckConfigPath(referencePath)
      ) {
        continue;
      }

      collectCheckerSourceConfigModules({
        checkerName: options.checkerName,
        collection: options.collection,
        config: options.config,
        excludedConfigPaths: options.excludedConfigPaths,
        problems: options.problems,
        sourceConfigPath: referencePath,
        seenConfigs: options.seenConfigs,
      });

      if (options.collection.buildModulesBySourcePath.has(referencePath)) {
        referenceSourceConfigPaths.push(referencePath);
      }
    }

    options.collection.solutionReferencesBySourcePath.set(
      options.sourceConfigPath,
      uniqueSortedStrings(referenceSourceConfigPaths),
    );

    return;
  }

  if (!isEmptyLeafConfig(configObject)) {
    options.collection.projectConfigPaths.add(options.sourceConfigPath);
    options.collection.buildModulesBySourcePath.set(
      options.sourceConfigPath,
      createProjectBuildModule({
        checkerName: options.checkerName,
        rootDir: options.config.rootDir,
        sourceConfigPath: options.sourceConfigPath,
      }),
    );
  }
}

function createGeneratedCompilerOptionOverrides(
  config: ResolvedLiminaConfig,
  project: SourceProject,
): Record<string, unknown> {
  const configObject = readJsonConfig(config, project.configPath);
  const compilerOptions = configObject.compilerOptions;
  const output: Record<string, unknown> = {};

  if (
    compilerOptions &&
    typeof compilerOptions === 'object' &&
    !Array.isArray(compilerOptions)
  ) {
    const types = (compilerOptions as { types?: unknown }).types;

    if (Array.isArray(types)) {
      output.types = types.filter(
        (typeName) =>
          typeof typeName !== 'string' ||
          (!typeName.startsWith('./') && !typeName.startsWith('../')),
      );
    }
  }

  const typeRoots = collectTypeRootCandidates({
    rootDir: config.rootDir,
    sourceConfigPath: project.configPath,
  });

  if (typeRoots.length > 0) {
    output.typeRoots = typeRoots.map((typeRoot) =>
      createRelativePath(project.dtsConfigPath, typeRoot),
    );
  }

  return output;
}

async function collectCheckerExcludedSourceConfigs(
  config: ResolvedLiminaConfig,
  exclude: string[],
): Promise<Set<string>> {
  if (exclude.length === 0) {
    return new Set();
  }

  const paths = await glob(exclude.map(normalizeWorkspaceGlob), {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });

  return new Set(paths.map(normalizeAbsolutePath));
}

async function collectCheckerSourceConfigs(
  config: ResolvedLiminaConfig,
  checkerName: string,
  include: string[],
  exclude: string[],
): Promise<CheckerSourceConfigCollection> {
  const includedPaths = await glob(include.map(normalizeWorkspaceGlob), {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });
  const includedSourcePaths = includedPaths.map(normalizeAbsolutePath).sort();
  const invalidEntryPaths = includedSourcePaths.filter(
    (sourcePath) => !isDefaultSourceTsconfigPath(sourcePath),
  );

  if (invalidEntryPaths.length > 0) {
    throw new Error(
      [
        'Checker include matched non-entry tsconfig files:',
        `  checker: ${checkerName}`,
        ...invalidEntryPaths.map(
          (sourcePath) => `  - ${toRelativePath(config.rootDir, sourcePath)}`,
        ),
        '  reason: checker.include may only match tsconfig.json entry files; non-standard tsconfig.*.json files become Limina-managed only when referenced from a managed tsconfig.json entry.',
      ].join('\n'),
    );
  }

  const problems: string[] = [];
  const excludedConfigPaths = await collectCheckerExcludedSourceConfigs(
    config,
    exclude,
  );
  const sourcePaths = includedSourcePaths.filter(
    (sourcePath) => !excludedConfigPaths.has(sourcePath),
  );
  const collection: CheckerSourceConfigCollection = {
    buildModulesBySourcePath: new Map(),
    entryConfigPaths: new Set(sourcePaths),
    projectConfigPaths: new Set(),
    rootConfigPaths: [],
    solutionConfigPaths: new Set(),
    solutionReferencesBySourcePath: new Map(),
  };
  const seenConfigs = new Set<string>();

  for (const sourcePath of sourcePaths) {
    collectCheckerSourceConfigModules({
      checkerName,
      collection,
      config,
      excludedConfigPaths,
      problems,
      sourceConfigPath: sourcePath,
      seenConfigs,
    });
  }

  if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config,
      fallback: 'Failed to collect checker source configs.',
      problems,
    });
  }

  collection.rootConfigPaths = uniqueSortedStrings(
    sourcePaths.filter((sourcePath) =>
      collection.buildModulesBySourcePath.has(sourcePath),
    ),
  );

  return collection;
}

function isAutoCheckerMode(config: ResolvedLiminaConfig): boolean {
  return (
    config.config?.checkers === undefined ||
    isAutoCheckerConfigMode(config.config.checkers)
  );
}

function getAutoCheckerExclude(config: ResolvedLiminaConfig): string[] {
  return isAutoCheckerConfigMode(config.config?.checkers)
    ? (config.config.checkers.exclude ?? [])
    : [];
}

function createResolvedChecker(options: {
  exclude?: string[];
  include: string[];
  name: string;
  preset: AutoCheckerPreset;
  rootDir: string;
}): ResolvedCheckerConfig {
  return {
    exclude: options.exclude ?? [],
    extensions: getCheckerExtensions(
      {
        include: options.include,
        preset: options.preset,
      },
      {
        projectRootDir: options.rootDir,
      },
    ),
    include: options.include,
    name: options.name,
    preset: options.preset,
  };
}

async function collectAutoEntryConfigPaths(
  config: ResolvedLiminaConfig,
  excludedConfigPaths: Set<string>,
): Promise<string[]> {
  const paths = await glob('**/tsconfig.json', {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });

  return paths
    .map(normalizeAbsolutePath)
    .filter(isDefaultSourceTsconfigPath)
    .filter((configPath) => !excludedConfigPaths.has(configPath))
    .sort((left, right) => left.localeCompare(right));
}

function createAutoScopeProject(
  config: ResolvedLiminaConfig,
  configPath: string,
): AutoScopeProject {
  const context: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions: capabilityDiscoveryExtensions,
  };
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
  });

  return {
    configPath,
    context,
    fileNames: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: parsed.options,
  };
}

function collectAutoScope(
  config: ResolvedLiminaConfig,
  entryConfigPath: string,
  excludedConfigPaths: Set<string>,
): AutoScope | null {
  const collection: CheckerSourceConfigCollection = {
    buildModulesBySourcePath: new Map(),
    entryConfigPaths: new Set([entryConfigPath]),
    projectConfigPaths: new Set(),
    rootConfigPaths: [],
    solutionConfigPaths: new Set(),
    solutionReferencesBySourcePath: new Map(),
  };
  const problems: string[] = [];

  collectCheckerSourceConfigModules({
    checkerName: '__auto__',
    collection,
    config,
    excludedConfigPaths,
    problems,
    sourceConfigPath: entryConfigPath,
    seenConfigs: new Set(),
  });

  if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config,
      fallback: 'Failed to collect auto checker scope.',
      problems,
    });
  }

  collection.rootConfigPaths = collection.buildModulesBySourcePath.has(
    entryConfigPath,
  )
    ? [entryConfigPath]
    : [];

  if (collection.projectConfigPaths.size === 0) {
    return null;
  }

  return {
    collection,
    entryConfigPath,
    projects: [...collection.projectConfigPaths]
      .sort((left, right) => left.localeCompare(right))
      .map((sourceConfigPath) =>
        createAutoScopeProject(config, sourceConfigPath),
      ),
  };
}

function formatUnsupportedAutoScopeExtensionProblem(options: {
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  extension: string;
  fileName: string;
}): string {
  return [
    'Unsupported auto checker source file extension:',
    `  scope: ${toRelativePath(options.config.rootDir, options.entryConfigPath)}`,
    `  extension: ${options.extension}`,
    `  example: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    '  reason: auto checker mode can only route TypeScript, JavaScript, JSON, and Vue source scopes.',
    '  fix: move this file to an explicit checker scope or configure config.checkers manually.',
  ].join('\n');
}

function classifyAutoScope(
  config: ResolvedLiminaConfig,
  scope: AutoScope,
): AutoCheckerPreset {
  const typescriptExtensions = new Set(
    getBuildCheckerSupportedExtensions('tsc'),
  );
  const vueExtensions = new Set(getBuildCheckerSupportedExtensions('vue-tsc'));
  let hasVueOnlyFile = false;

  for (const project of scope.projects) {
    for (const fileName of project.fileNames) {
      const extension = getFileExtension(fileName);

      if (!extension) {
        continue;
      }

      if (!vueExtensions.has(extension)) {
        throw new Error(
          formatUnsupportedAutoScopeExtensionProblem({
            config,
            entryConfigPath: scope.entryConfigPath,
            extension,
            fileName,
          }),
        );
      }

      if (!typescriptExtensions.has(extension)) {
        hasVueOnlyFile = true;
      }
    }
  }

  return hasVueOnlyFile ? 'vue-tsc' : 'tsc';
}

function isAutoRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function collectAutoImportCandidatePaths(options: {
  containingFile: string;
  resolvedFilePath: string | null;
  specifier: string;
}): string[] {
  const candidates = new Set<string>();

  if (options.resolvedFilePath) {
    candidates.add(normalizeAbsolutePath(options.resolvedFilePath));
  }

  if (!isAutoRelativeSpecifier(options.specifier)) {
    return [...candidates];
  }

  const basePath = path.resolve(
    path.dirname(options.containingFile),
    options.specifier,
  );

  if (path.extname(basePath)) {
    candidates.add(normalizeAbsolutePath(basePath));
    return [...candidates];
  }

  for (const extension of capabilityDiscoveryExtensions) {
    candidates.add(normalizeAbsolutePath(`${basePath}${extension}`));
    candidates.add(
      normalizeAbsolutePath(path.join(basePath, `index${extension}`)),
    );
  }

  return [...candidates];
}

function collectAutoScopeDependencies(
  config: ResolvedLiminaConfig,
  scopes: AutoScope[],
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    'importAnalysisContext'
  > = {},
): Map<string, Set<string>> {
  const dependenciesByEntry = new Map(
    scopes.map((scope) => [scope.entryConfigPath, new Set<string>()]),
  );
  const scopeEntries = new Set(scopes.map((scope) => scope.entryConfigPath));
  const entryPathsByFileName = new Map<string, Set<string>>();
  const importAnalysis =
    options.importAnalysisContext ??
    createImportAnalysisContext({
      isolated: true,
      projectRootDir: config.rootDir,
      vueParser: config.config?.imports?.vue,
    });

  for (const scope of scopes) {
    for (const project of scope.projects) {
      for (const fileName of project.fileNames) {
        const entries = entryPathsByFileName.get(fileName) ?? new Set<string>();

        entries.add(scope.entryConfigPath);
        entryPathsByFileName.set(fileName, entries);
      }
    }
  }

  for (const scope of scopes) {
    const dependencies =
      dependenciesByEntry.get(scope.entryConfigPath) ?? new Set<string>();

    for (const references of scope.collection.solutionReferencesBySourcePath.values()) {
      for (const referencePath of references) {
        if (
          scopeEntries.has(referencePath) &&
          referencePath !== scope.entryConfigPath
        ) {
          dependencies.add(referencePath);
        }
      }
    }

    for (const project of scope.projects) {
      for (const fileName of project.fileNames) {
        for (const importRecord of collectImportsFromFile(
          fileName,
          config.rootDir,
          importAnalysis,
        )) {
          const resolvedFilePath = resolveInternalImport(
            importRecord.specifier,
            fileName,
            project.options,
            {
              ...project.context,
              configPath: project.configPath,
              resolverConfigPath: project.configPath,
            },
            importAnalysis,
          );

          for (const candidatePath of collectAutoImportCandidatePaths({
            containingFile: fileName,
            resolvedFilePath,
            specifier: importRecord.specifier,
          })) {
            for (const targetEntryPath of entryPathsByFileName.get(
              candidatePath,
            ) ?? []) {
              if (targetEntryPath !== scope.entryConfigPath) {
                dependencies.add(targetEntryPath);
              }
            }
          }
        }
      }
    }
  }

  return dependenciesByEntry;
}

function promoteAutoScopes(
  kindsByEntry: Map<string, AutoCheckerPreset>,
  dependenciesByEntry: Map<string, Set<string>>,
): void {
  let changed = true;

  while (changed) {
    changed = false;

    for (const [entryConfigPath, dependencies] of dependenciesByEntry) {
      if (kindsByEntry.get(entryConfigPath) !== 'tsc') {
        continue;
      }

      for (const dependencyPath of dependencies) {
        if (kindsByEntry.get(dependencyPath) !== 'vue-tsc') {
          continue;
        }

        kindsByEntry.set(entryConfigPath, 'vue-tsc');
        changed = true;
        break;
      }
    }
  }
}

async function resolveAutoCheckers(
  config: ResolvedLiminaConfig,
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    'importAnalysisContext'
  > = {},
): Promise<ResolvedCheckerConfig[]> {
  const autoExclude = getAutoCheckerExclude(config);
  const excludedConfigPaths = await collectCheckerExcludedSourceConfigs(
    config,
    autoExclude,
  );
  const entryConfigPaths = await collectAutoEntryConfigPaths(
    config,
    excludedConfigPaths,
  );
  const scopes = entryConfigPaths
    .map((entryConfigPath) =>
      collectAutoScope(config, entryConfigPath, excludedConfigPaths),
    )
    .filter((scope): scope is AutoScope => Boolean(scope));
  const kindsByEntry = new Map(
    scopes.map((scope) => [
      scope.entryConfigPath,
      classifyAutoScope(config, scope),
    ]),
  );

  promoteAutoScopes(
    kindsByEntry,
    collectAutoScopeDependencies(config, scopes, options),
  );

  const entriesByPreset = new Map<AutoCheckerPreset, string[]>();

  for (const [entryConfigPath, preset] of kindsByEntry) {
    entriesByPreset.set(preset, [
      ...(entriesByPreset.get(preset) ?? []),
      toPosixPath(toRelativePath(config.rootDir, entryConfigPath)),
    ]);
  }

  const checkers: ResolvedCheckerConfig[] = [];
  const typescriptEntries = entriesByPreset.get('tsc')?.sort() ?? [];
  const vueEntries = entriesByPreset.get('vue-tsc')?.sort() ?? [];

  if (typescriptEntries.length > 0) {
    checkers.push(
      createResolvedChecker({
        exclude: autoExclude,
        include: typescriptEntries,
        name: 'typescript',
        preset: 'tsc',
        rootDir: config.rootDir,
      }),
    );
  }

  if (vueEntries.length > 0) {
    checkers.push(
      createResolvedChecker({
        exclude: autoExclude,
        include: vueEntries,
        name: 'vue',
        preset: 'vue-tsc',
        rootDir: config.rootDir,
      }),
    );
  }

  return checkers;
}

export async function resolveGeneratedGraphCheckers(
  config: ResolvedLiminaConfig,
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    'importAnalysisContext'
  > = {},
): Promise<ResolvedCheckerConfig[]> {
  return isAutoCheckerMode(config)
    ? resolveAutoCheckers(config, options)
    : getActiveCheckers(config);
}

function createSourceProject(options: {
  checkerName: string;
  checkerPreset: SourceProject['context']['checkerPresets'][number];
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): SourceProject {
  const extensions = resolveCheckerProjectExtensions({
    configPath: options.sourceConfigPath,
    preset: options.checkerPreset,
    projectRootDir: options.config.rootDir,
  });
  const context: CheckerProjectParseContext = {
    checkerPresets: [options.checkerPreset],
    extensions,
  };
  const parsed = parseCheckerProjectConfigForContext({
    configPath: options.sourceConfigPath,
    context,
    projectRootDir: options.config.rootDir,
  });
  const ownedFileNames = parsed.fileNames.map(normalizeAbsolutePath).sort();
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
  );

  return {
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    context,
    dtsConfigPath: getGeneratedDtsConfigPath({
      checkerName: options.checkerName,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    fileNames: uniqueSortedStrings([
      ...ownedFileNames,
      ...readRelativeTypeFiles(options.config, options.sourceConfigPath),
    ]),
    graphRules: readGraphRules(options.config, options.sourceConfigPath),
    ownedFileNames,
    outputConfigPath: getGeneratedOutputProjectConfigPath({
      checkerName: options.checkerName,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    outputOptions: outputOptions.outputs,
    outputReferences: new Set(),
    options: parsed.options,
    references: new Set(),
  };
}

function createSolutionProject(options: {
  checkerName: string;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): SolutionProject {
  const referenceSourceConfigPaths =
    options.collection.solutionReferencesBySourcePath.get(
      options.sourceConfigPath,
    ) ?? [];

  return {
    buildConfigPath: getGeneratedSolutionBuildConfigPath({
      checkerName: options.checkerName,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    references: new Set(
      referenceSourceConfigPaths
        .map(
          (sourceConfigPath) =>
            options.collection.buildModulesBySourcePath.get(sourceConfigPath)
              ?.path,
        )
        .filter((buildPath): buildPath is string => Boolean(buildPath)),
    ),
  };
}

function createSourceProjectsByDtsPath(
  projects: SourceProject[],
): Map<string, SourceProject> {
  return new Map(projects.map((project) => [project.dtsConfigPath, project]));
}

function createOutputSolutionProject(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  references: string[];
  sourceConfigPath: string;
}): OutputSolutionProject {
  return {
    buildConfigPath: getGeneratedOutputSolutionConfigPath({
      checkerName: options.checkerName,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    references: new Set(options.references),
  };
}

function createOutputDeclarationCopyContext(
  project: SourceProject,
): GeneratedOutputDeclarationCopyContext | null {
  if (!project.outputOptions) {
    return null;
  }

  return {
    fileNames: [...project.fileNames],
    outDir: project.outputOptions.outDir,
    rootDir: project.outputOptions.rootDir,
    sourceConfigPath: project.configPath,
  };
}

function collectFlattenedOutputSolutionReferences(options: {
  collection: CheckerSourceConfigCollection;
  outputProjectModuleBySourcePath: Map<string, GeneratedBuildModule>;
  sourceConfigPath: string;
  seenConfigPaths?: Set<string>;
}): string[] {
  const seenConfigPaths = options.seenConfigPaths ?? new Set<string>();

  if (seenConfigPaths.has(options.sourceConfigPath)) {
    return [];
  }

  seenConfigPaths.add(options.sourceConfigPath);

  const references =
    options.collection.solutionReferencesBySourcePath.get(
      options.sourceConfigPath,
    ) ?? [];
  const outputReferences = new Set<string>();

  for (const referencePath of references) {
    const outputProjectModule =
      options.outputProjectModuleBySourcePath.get(referencePath);

    if (outputProjectModule) {
      outputReferences.add(outputProjectModule.path);
      continue;
    }

    for (const nestedReferencePath of collectFlattenedOutputSolutionReferences({
      collection: options.collection,
      outputProjectModuleBySourcePath: options.outputProjectModuleBySourcePath,
      sourceConfigPath: referencePath,
      seenConfigPaths,
    })) {
      outputReferences.add(nestedReferencePath);
    }
  }

  return [...outputReferences].sort((left, right) => left.localeCompare(right));
}

function formatMissingOutputDependencyProblem(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
  targetProject: SourceProject;
}): string {
  return [
    'Missing Limina output options for referenced source project:',
    `  config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  referenced config: ${toRelativePath(options.config.rootDir, options.targetProject.configPath)}`,
    '  reason: this output-enabled source project has a Limina-generated project reference to another managed source project that does not declare liminaOptions.outputs.',
    '  fix: add liminaOptions.outputs to the referenced source config, or move the dependency behind a declaration or artifact boundary.',
  ].join('\n');
}

function createCheckerOutputGraph(options: {
  allProjectsByDtsPath: Map<string, SourceProject>;
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProject[];
}): CheckerOutputGraph {
  if (getCheckerAdapter(options.checker.preset)?.execution !== 'build') {
    return {
      configToOutputBuild: new Map(),
      outputDeclarationCopies: new Map(),
      outputProjects: [],
      outputSolutions: [],
    };
  }

  const outputProjects = options.projects.filter((project) =>
    Boolean(project.outputOptions),
  );
  const outputProjectModuleBySourcePath = new Map(
    outputProjects.map((project) => [
      project.configPath,
      createOutputProjectBuildModule({
        checkerName: options.checker.name,
        rootDir: options.config.rootDir,
        sourceConfigPath: project.configPath,
      }),
    ]),
  );
  const configToOutputBuild = new Map<string, GeneratedBuildModule>(
    outputProjectModuleBySourcePath,
  );
  const outputProjectByOutputConfigPath = new Map(
    outputProjects.map((project) => [project.outputConfigPath, project]),
  );
  const outputDeclarationCopies = new Map<
    string,
    GeneratedOutputDeclarationCopyContext[]
  >();

  for (const project of outputProjects) {
    const copyContext = createOutputDeclarationCopyContext(project);

    if (!copyContext) {
      continue;
    }

    outputDeclarationCopies.set(project.configPath, [copyContext]);
  }

  for (const project of outputProjects) {
    for (const referencePath of project.references) {
      const targetProject = options.allProjectsByDtsPath.get(referencePath);

      if (!targetProject) {
        continue;
      }

      if (!targetProject.outputOptions) {
        options.problems.push(
          formatMissingOutputDependencyProblem({
            config: options.config,
            project,
            targetProject,
          }),
        );
        continue;
      }

      project.outputReferences.add(targetProject.outputConfigPath);
    }
  }

  const outputSolutions: OutputSolutionProject[] = [];

  for (const sourceConfigPath of [
    ...options.collection.solutionConfigPaths,
  ].sort((left, right) => left.localeCompare(right))) {
    const references = collectFlattenedOutputSolutionReferences({
      collection: options.collection,
      outputProjectModuleBySourcePath,
      sourceConfigPath,
    });

    if (references.length === 0) {
      continue;
    }

    const outputSolution = createOutputSolutionProject({
      checkerName: options.checker.name,
      config: options.config,
      references,
      sourceConfigPath,
    });

    outputSolutions.push(outputSolution);
    configToOutputBuild.set(
      sourceConfigPath,
      createOutputSolutionBuildModule({
        checkerName: options.checker.name,
        rootDir: options.config.rootDir,
        sourceConfigPath,
      }),
    );
    outputDeclarationCopies.set(
      sourceConfigPath,
      references
        .map((referencePath) =>
          outputProjectByOutputConfigPath.get(referencePath),
        )
        .filter((project): project is SourceProject => Boolean(project))
        .map(createOutputDeclarationCopyContext)
        .filter(
          (copyContext): copyContext is GeneratedOutputDeclarationCopyContext =>
            Boolean(copyContext),
        )
        .sort((left, right) =>
          left.sourceConfigPath.localeCompare(right.sourceConfigPath),
        ),
    );
  }

  return {
    configToOutputBuild,
    outputDeclarationCopies,
    outputProjects,
    outputSolutions,
  };
}

function createDtsProjectsBySourcePath(
  projects: SourceProject[],
): Map<string, SourceProject[]> {
  const projectsBySourcePath = new Map<string, SourceProject[]>();

  for (const project of projects) {
    projectsBySourcePath.set(project.configPath, [
      ...(projectsBySourcePath.get(project.configPath) ?? []),
      project,
    ]);
  }

  return projectsBySourcePath;
}

function getDtsConfigPathForSourcePath(options: {
  checkerName: string;
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  sourceConfigPath: string;
}): string | undefined {
  const candidates =
    options.dtsProjectsBySourcePath.get(options.sourceConfigPath) ?? [];

  return candidates.find(
    (project) => project.checkerName === options.checkerName,
  )?.dtsConfigPath;
}

function getDtsProjectsForSourcePath(options: {
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  sourceConfigPath: string;
}): SourceProject[] {
  return options.dtsProjectsBySourcePath.get(options.sourceConfigPath) ?? [];
}

function createManagedOutputProjectContexts(
  projects: SourceProject[],
): ManagedOutputProjectContext[] {
  return projects
    .filter(
      (project): project is SourceProject & { outputOptions: OutputOptions } =>
        Boolean(project.outputOptions),
    )
    .map((project) => ({
      checkerName: project.checkerName,
      sourceConfigPath: project.configPath,
      outputOptions: {
        outDir: project.outputOptions.outDir,
        rootDir: project.outputOptions.rootDir,
      },
      ownedFileNames: project.ownedFileNames,
      extensions: project.context.extensions,
    }));
}

function isBuildCapableProject(project: SourceProject): boolean {
  const preset = project.context.checkerPresets[0];

  return preset ? getCheckerAdapter(preset)?.execution === 'build' : false;
}

function selectProviderProject(options: {
  providerSourceFilePath: string;
  sourceCheckerName: string;
  targetProjects: SourceProject[];
}): SourceProject | null {
  const providerProjects = options.targetProjects
    .filter((project) => project.checkerName !== options.sourceCheckerName)
    .filter((project) =>
      project.ownedFileNames.includes(options.providerSourceFilePath),
    )
    .filter(isBuildCapableProject)
    .sort((left, right) => left.checkerName.localeCompare(right.checkerName));

  return providerProjects[0] ?? null;
}

interface UnsupportedCrossCheckerProviderFile {
  extension: string;
  fileName: string;
  generatedConfigPath: string;
  sourceConfigPath: string;
}

function createSourceProjectKey(
  checkerName: string,
  configPath: string,
): string {
  return JSON.stringify([checkerName, configPath]);
}

function collectGeneratedDtsProjectClosure(options: {
  projectByDtsConfigPath: Map<string, SourceProject>;
  rootProject: SourceProject;
}): SourceProject[] {
  const closure: SourceProject[] = [];
  const seen = new Set<string>();
  const queue = [options.rootProject];

  for (;;) {
    const project = queue.shift();

    if (!project) {
      break;
    }

    if (seen.has(project.dtsConfigPath)) {
      continue;
    }

    seen.add(project.dtsConfigPath);
    closure.push(project);

    for (const referencePath of project.references) {
      const referenceProject =
        options.projectByDtsConfigPath.get(referencePath);

      if (!referenceProject || seen.has(referenceProject.dtsConfigPath)) {
        continue;
      }

      queue.push(referenceProject);
    }
  }

  return closure;
}

function collectUnsupportedCrossCheckerProviderFiles(options: {
  consumerProject: SourceProject;
  projectByDtsConfigPath: Map<string, SourceProject>;
  providerProject: SourceProject;
}): UnsupportedCrossCheckerProviderFile[] {
  const consumerPreset = options.consumerProject.context.checkerPresets[0];
  const supportedExtensions = new Set(
    consumerPreset
      ? [
          ...getBuildCheckerSupportedExtensions(consumerPreset),
          ...options.consumerProject.context.extensions,
        ]
      : options.consumerProject.context.extensions,
  );
  const unsupportedFiles: UnsupportedCrossCheckerProviderFile[] = [];

  for (const project of collectGeneratedDtsProjectClosure({
    projectByDtsConfigPath: options.projectByDtsConfigPath,
    rootProject: options.providerProject,
  })) {
    for (const fileName of project.fileNames) {
      const extension = getFileExtension(fileName);

      if (!extension || supportedExtensions.has(extension)) {
        continue;
      }

      unsupportedFiles.push({
        extension,
        fileName,
        generatedConfigPath: project.dtsConfigPath,
        sourceConfigPath: project.configPath,
      });
    }
  }

  return unsupportedFiles.sort(
    (left, right) =>
      left.generatedConfigPath.localeCompare(right.generatedConfigPath) ||
      left.extension.localeCompare(right.extension) ||
      left.fileName.localeCompare(right.fileName),
  );
}

function formatUnsupportedCrossCheckerProviderProblem(options: {
  config: ResolvedLiminaConfig;
  consumerProject: SourceProject;
  edge: GeneratedProviderEdge;
  providerProject: SourceProject;
  unsupportedFiles: UnsupportedCrossCheckerProviderFile[];
}): string {
  const consumerPreset =
    options.consumerProject.context.checkerPresets[0] ?? 'unknown';
  const providerPreset =
    options.providerProject.context.checkerPresets[0] ?? 'unknown';
  const unsupportedLines = options.unsupportedFiles.map((file) => [
    `  - generated config: ${toRelativePath(options.config.rootDir, file.generatedConfigPath)}`,
    `    source config: ${toRelativePath(options.config.rootDir, file.sourceConfigPath)}`,
    `    extension: ${file.extension}`,
    `    example: ${toRelativePath(options.config.rootDir, file.fileName)}`,
  ]);

  return [
    'Unsupported cross-checker declaration provider:',
    `  consumer checker: ${options.consumerProject.checkerName} (${consumerPreset})`,
    `  consumer config: ${toRelativePath(options.config.rootDir, options.consumerProject.configPath)}`,
    `  provider checker: ${options.providerProject.checkerName} (${providerPreset})`,
    `  provider config: ${toRelativePath(options.config.rootDir, options.providerProject.configPath)}`,
    `  file: ${options.edge.file}`,
    `  imported specifier: ${options.edge.importedSpecifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.edge.resolvedFilePath)}`,
    '  unsupported provider files:',
    ...unsupportedLines.flat(),
    '  reason: cross-checker provider references must be buildable by the consumer checker across the entire generated declaration reference tree.',
    '  fix: cover the target source config with the consumer checker, or expose a TypeScript-only boundary that the consumer checker can build.',
  ].join('\n');
}

function addCrossCheckerProviderCompatibilityProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProject[];
  providerEdges: GeneratedProviderEdge[];
}): void {
  const projectBySourceKey = new Map(
    options.projects.map((project) => [
      createSourceProjectKey(project.checkerName, project.configPath),
      project,
    ]),
  );
  const projectByDtsConfigPath = new Map(
    options.projects.map((project) => [project.dtsConfigPath, project]),
  );

  for (const edge of options.providerEdges) {
    const consumerProject = projectBySourceKey.get(
      createSourceProjectKey(edge.fromChecker, edge.fromConfigPath),
    );
    const providerProject = projectBySourceKey.get(
      createSourceProjectKey(edge.toChecker, edge.toConfigPath),
    );

    if (!consumerProject || !providerProject) {
      continue;
    }

    const unsupportedFiles = collectUnsupportedCrossCheckerProviderFiles({
      consumerProject,
      projectByDtsConfigPath,
      providerProject,
    });

    if (unsupportedFiles.length === 0) {
      continue;
    }

    options.problems.push(
      formatUnsupportedCrossCheckerProviderProblem({
        config: options.config,
        consumerProject,
        edge,
        providerProject,
        unsupportedFiles,
      }),
    );
  }
}

function formatMissingCrossCheckerProviderProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ReturnType<typeof collectImportsFromFile>[number];
  project: SourceProject;
  resolvedFilePath: string;
  targetProjects: SourceProject[];
  targetSourceConfigPath: string;
}): string {
  return [
    'Unable to resolve cross-checker declaration provider:',
    `  from checker: ${options.project.checkerName}`,
    `  from config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  candidate checker: ${options.targetProjects.map((project) => project.checkerName).join(', ')}`,
    `  target config: ${toRelativePath(options.config.rootDir, options.targetSourceConfigPath)}`,
    '  reason: cross-checker imports need a build-capable checker that owns the resolved file.',
    '  fix: cover the target source config with a build-capable checker preset such as tsc, tsgo, or vue-tsc.',
  ].join('\n');
}

function formatOxcOnlyDeclarationProviderProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ReturnType<typeof collectImportsFromFile>[number];
  oxcResolvedFilePath: string;
  project: SourceProject;
}): string {
  return [
    'Oxc can resolve this specifier, but TypeScript cannot:',
    `  importing config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  Oxc resolved file: ${toRelativePath(options.config.rootDir, options.oxcResolvedFilePath)}`,
    '  reason: generated declaration references follow the checker-aware TypeScript declaration provider, not the Oxc runtime-like resolver.',
    '  fix: check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
  ].join('\n');
}

function inferProjectReferences(
  config: ResolvedLiminaConfig,
  projects: SourceProject[],
  ownerProjects: SourceProject[] = projects,
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    'importAnalysisContext'
  > = {},
): InferredProjectReferenceCollection {
  const problems: string[] = [];
  const providerEdgesByKey = new Map<string, GeneratedProviderEdge>();
  const importAnalysis =
    options.importAnalysisContext ??
    createImportAnalysisContext({
      isolated: true,
      projectRootDir: config.rootDir,
      vueParser: config.config?.imports?.vue,
    });
  const ownerLookup = createFileOwnerLookup(
    ownerProjects.map((project) => ({
      checkerPresets: project.context.checkerPresets,
      configPath: project.configPath,
      extensions: project.context.extensions,
      fileNames: project.ownedFileNames,
      labels: project.graphRules,
      labelProblem: null,
      ownedFileNames: project.ownedFileNames,
      options: project.options,
      references: project.references,
      resolverConfigPath: project.configPath,
    })),
  );
  const managedOutputLookup = createManagedOutputDeclarationLookup(
    createManagedOutputProjectContexts(ownerProjects),
  );
  const localDtsProjectsBySourcePath = createDtsProjectsBySourcePath(projects);
  const dtsProjectsBySourcePath = createDtsProjectsBySourcePath(ownerProjects);

  for (const project of projects) {
    addSourceReferenceConfigProblems({
      config,
      problems,
      sourceConfigPath: project.configPath,
    });

    const implicitRefCollection = readImplicitRefs(config, project.configPath);

    problems.push(...implicitRefCollection.problems);

    for (const implicitRef of implicitRefCollection.implicitRefs) {
      const targetDtsConfigPath = getDtsConfigPathForSourcePath({
        checkerName: project.checkerName,
        dtsProjectsBySourcePath: localDtsProjectsBySourcePath,
        sourceConfigPath: implicitRef.targetConfigPath,
      });

      if (!targetDtsConfigPath) {
        problems.push(
          [
            'Unable to map Limina implicit reference to a generated declaration project:',
            `  config: ${toRelativePath(config.rootDir, project.configPath)}`,
            `  field: liminaOptions.implicitRefs`,
            `  reference: ${implicitRef.path}`,
            `  resolved: ${toRelativePath(config.rootDir, implicitRef.targetConfigPath)}`,
            '  reason: implicitRefs must point to an ordinary source tsconfig selected by the same checker.include set.',
          ].join('\n'),
        );
        continue;
      }

      project.references.add(targetDtsConfigPath);
    }
  }

  for (const project of projects) {
    for (const fileName of project.ownedFileNames) {
      for (const importRecord of collectImportsFromFile(
        fileName,
        config.rootDir,
        importAnalysis,
      )) {
        const declarationProvider = resolveDeclarationProvider({
          compilerOptions: project.options,
          containingFile: fileName,
          fileOwnerLookup: ownerLookup,
          importAnalysis,
          importRecord,
          project: {
            ...project.context,
            configPath: project.configPath,
            resolverConfigPath: project.configPath,
          },
        });

        if (declarationProvider.kind === 'oxc-only') {
          problems.push(
            formatOxcOnlyDeclarationProviderProblem({
              config,
              importRecord,
              oxcResolvedFilePath: declarationProvider.oxcResolvedFilePath,
              project,
            }),
          );
          continue;
        }

        if (declarationProvider.kind === 'unresolved') {
          continue;
        }

        const resolvedFilePath =
          declarationProvider.typeScriptResolution.resolvedFileName;
        let providerSourceFilePath = resolvedFilePath;
        let targetSourceConfigPath: string | null = null;

        if (declarationProvider.kind === 'declaration') {
          const attribution = managedOutputLookup.resolve(
            resolvedFilePath,
            project.checkerName,
          );

          if (!attribution) {
            continue;
          }

          providerSourceFilePath = attribution.mappedSourceFilePath;
          targetSourceConfigPath = attribution.sourceConfigPath;
        } else {
          const owners = declarationProvider.ownerProjectPaths;

          if (!owners || owners.length === 0) {
            continue;
          }

          targetSourceConfigPath =
            owners
              .filter((owner) => owner !== project.configPath)
              .sort(
                (left, right) =>
                  path.dirname(right).length - path.dirname(left).length ||
                  left.localeCompare(right),
              )[0] ?? null;
        }

        if (
          !targetSourceConfigPath ||
          targetSourceConfigPath === project.configPath
        ) {
          continue;
        }

        const targetDtsConfigPath = getDtsConfigPathForSourcePath({
          checkerName: project.checkerName,
          dtsProjectsBySourcePath,
          sourceConfigPath: targetSourceConfigPath,
        });

        if (!targetDtsConfigPath) {
          const targetProjects = getDtsProjectsForSourcePath({
            dtsProjectsBySourcePath,
            sourceConfigPath: targetSourceConfigPath,
          }).filter(
            (targetProject) =>
              targetProject.checkerName !== project.checkerName,
          );

          if (targetProjects.length > 0) {
            const providerProject = selectProviderProject({
              providerSourceFilePath,
              sourceCheckerName: project.checkerName,
              targetProjects,
            });

            if (!providerProject) {
              problems.push(
                formatMissingCrossCheckerProviderProblem({
                  config,
                  importRecord,
                  project,
                  resolvedFilePath,
                  targetProjects,
                  targetSourceConfigPath,
                }),
              );
              continue;
            }

            if (
              isDeniedGeneratedReference(
                config,
                project,
                targetSourceConfigPath,
              )
            ) {
              continue;
            }

            const providerEdge: GeneratedProviderEdge = {
              file: formatImportRecordLocation(config.rootDir, importRecord),
              fromChecker: project.checkerName,
              fromConfigPath: project.configPath,
              importedSpecifier: importRecord.specifier,
              resolvedFilePath,
              toChecker: providerProject.checkerName,
              toConfigPath: targetSourceConfigPath,
            };
            const providerEdgeKey = JSON.stringify([
              providerEdge.fromChecker,
              providerEdge.fromConfigPath,
              providerEdge.toChecker,
              providerEdge.toConfigPath,
              providerEdge.file,
              providerEdge.importedSpecifier,
              providerEdge.resolvedFilePath,
            ]);

            providerEdgesByKey.set(providerEdgeKey, providerEdge);
            project.references.add(providerProject.dtsConfigPath);
            continue;
          }

          problems.push(
            [
              'Unable to map generated graph import to a declaration project:',
              `  importing config: ${toRelativePath(config.rootDir, project.configPath)}`,
              `  file: ${formatImportRecordLocation(config.rootDir, importRecord)}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  resolved file: ${toRelativePath(config.rootDir, resolvedFilePath)}`,
            ].join('\n'),
          );
          continue;
        }

        if (
          isDeniedGeneratedReference(config, project, targetSourceConfigPath)
        ) {
          continue;
        }

        project.references.add(targetDtsConfigPath);
      }
    }
  }

  return {
    problems,
    providerEdges: [...providerEdgesByKey.values()].sort(
      (left, right) =>
        left.fromChecker.localeCompare(right.fromChecker) ||
        left.fromConfigPath.localeCompare(right.fromConfigPath) ||
        left.toChecker.localeCompare(right.toChecker) ||
        left.toConfigPath.localeCompare(right.toConfigPath) ||
        left.file.localeCompare(right.file) ||
        left.importedSpecifier.localeCompare(right.importedSpecifier),
    ),
  };
}

function isDeniedGeneratedReference(
  config: ResolvedLiminaConfig,
  project: SourceProject,
  targetSourceConfigPath: string,
): boolean {
  const rules = config.graph?.rules;

  if (!rules) {
    return false;
  }

  for (const label of project.graphRules) {
    const denyRefs = rules[label]?.deny?.refs;

    if (!denyRefs) {
      continue;
    }

    for (const ref of denyRefs) {
      const deniedPath = normalizeAbsolutePath(
        path.resolve(config.rootDir, ref.path),
      );
      const deniedSourcePath = deniedPath.endsWith('.dts.json')
        ? normalizeAbsolutePath(deniedPath.replace(/\.dts\.json$/u, '.json'))
        : deniedPath;

      if (deniedSourcePath === targetSourceConfigPath) {
        return true;
      }
    }
  }

  return false;
}

function isSameOrParentDirectory(
  parentDirectory: string,
  childDirectory: string,
): boolean {
  const relativePath = path.relative(parentDirectory, childDirectory);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function containsAllDirectories(
  parentDirectory: string,
  childDirectories: string[],
): boolean {
  for (const childDirectory of childDirectories) {
    if (!isSameOrParentDirectory(parentDirectory, childDirectory)) {
      return false;
    }
  }

  return true;
}

function getCommonSourceRootDir(project: SourceProject): string {
  const fileDirectories = project.fileNames.map((fileName) =>
    path.dirname(fileName),
  );

  if (fileDirectories.length === 0) {
    return path.dirname(project.configPath);
  }

  let commonDirectory = fileDirectories[0]!;

  while (!containsAllDirectories(commonDirectory, fileDirectories)) {
    const parentDirectory = path.dirname(commonDirectory);

    if (parentDirectory === commonDirectory) {
      return commonDirectory;
    }

    commonDirectory = parentDirectory;
  }

  return commonDirectory;
}

function createGeneratedDtsConfig(
  config: ResolvedLiminaConfig,
  project: SourceProject,
): Record<string, unknown> {
  const liminaOptions: Record<string, unknown> = {
    generated: true,
    checker: project.checkerName,
    sourceConfig: createRelativePath(project.dtsConfigPath, project.configPath),
  };

  if (project.graphRules.length > 0) {
    liminaOptions.graphRules = project.graphRules;
  }

  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      project.dtsConfigPath,
    ),
    extends: [createRelativePath(project.dtsConfigPath, project.configPath)],
    files: project.fileNames.map((fileName) =>
      createRelativePath(project.dtsConfigPath, fileName),
    ),
    compilerOptions: {
      ...createGeneratedCompilerOptionOverrides(config, project),
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      rootDir: createRelativePath(
        project.dtsConfigPath,
        getCommonSourceRootDir(project),
      ),
      outDir: createRelativePath(
        project.dtsConfigPath,
        getGeneratedOutDir({
          checkerName: project.checkerName,
          rootDir: config.rootDir,
          sourceConfigPath: project.configPath,
        }),
      ),
      tsBuildInfoFile: createRelativePath(
        project.dtsConfigPath,
        getGeneratedTsBuildInfoPath({
          checkerName: project.checkerName,
          rootDir: config.rootDir,
          sourceConfigPath: project.configPath,
        }),
      ),
    },
    references: [...project.references].sort().map((referencePath) => ({
      path: createRelativePath(project.dtsConfigPath, referencePath),
    })),
    liminaOptions,
  };
}

function createGeneratedOutputProjectConfig(
  config: ResolvedLiminaConfig,
  project: SourceProject,
): Record<string, unknown> {
  if (!project.outputOptions) {
    throw new Error(
      `Missing output options for ${toRelativePath(config.rootDir, project.configPath)}.`,
    );
  }

  const outputOptions = project.outputOptions;

  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      project.outputConfigPath,
    ),
    extends: [createRelativePath(project.outputConfigPath, project.configPath)],
    files: project.fileNames.map((fileName) =>
      createRelativePath(project.outputConfigPath, fileName),
    ),
    compilerOptions: {
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      declarationMap: outputOptions.declarationMap,
      emitDeclarationOnly: false,
      target: outputOptions.target,
      rootDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.rootDir,
      ),
      outDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.outDir,
      ),
      declarationDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.outDir,
      ),
      tsBuildInfoFile: createRelativePath(
        project.outputConfigPath,
        getGeneratedOutputTsBuildInfoPath({
          rootDir: config.rootDir,
          sourceConfigPath: project.configPath,
        }),
      ),
    },
    references: [...project.outputReferences].sort().map((referencePath) => ({
      path: createRelativePath(project.outputConfigPath, referencePath),
    })),
    liminaOptions: {
      generated: true,
      checker: project.checkerName,
      sourceConfig: createRelativePath(
        project.outputConfigPath,
        project.configPath,
      ),
    },
  };
}

function createGeneratedSolutionBuildConfig(
  config: ResolvedLiminaConfig,
  solution: SolutionProject,
): Record<string, unknown> {
  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      solution.buildConfigPath,
    ),
    files: [],
    references: [...solution.references].sort().map((referencePath) => ({
      path: createRelativePath(solution.buildConfigPath, referencePath),
    })),
    liminaOptions: {
      generated: true,
      checker: solution.checkerName,
      sourceConfig: createRelativePath(
        solution.buildConfigPath,
        solution.configPath,
      ),
    },
  };
}

function createGeneratedOutputSolutionConfig(
  config: ResolvedLiminaConfig,
  solution: OutputSolutionProject,
): Record<string, unknown> {
  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      solution.buildConfigPath,
    ),
    files: [],
    references: [...solution.references].sort().map((referencePath) => ({
      path: createRelativePath(solution.buildConfigPath, referencePath),
    })),
    liminaOptions: {
      generated: true,
      checker: solution.checkerName,
      sourceConfig: createRelativePath(
        solution.buildConfigPath,
        solution.configPath,
      ),
    },
  };
}

function createCheckerBuildConfig(options: {
  checkerName: string;
  entryPath: string;
  references: string[];
  rootDir: string;
}): Record<string, unknown> {
  return {
    $schema: createLiminaTsconfigSchemaPath(options.rootDir, options.entryPath),
    files: [],
    references: options.references.sort().map((referencePath) => ({
      path: createRelativePath(options.entryPath, referencePath),
    })),
    liminaOptions: {
      generated: true,
      checker: options.checkerName,
    },
  };
}

async function writeGeneratedJson(
  context: GeneratedGraphWriteContext,
  filePath: string,
  value: unknown,
): Promise<void> {
  const content = stringifyJson(value);

  context.expectedFiles.add(filePath);

  if (existsSync(filePath)) {
    const previousContent = await readFile(filePath, 'utf8');

    if (previousContent === content) {
      return;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  context.changed = true;
}

async function removeStaleGeneratedFiles(
  context: GeneratedGraphWriteContext,
): Promise<void> {
  const generatedFiles = await glob(
    [
      `${generatedTsconfigDir}/**/*.json`,
      `${generatedRootDirName}/knip/**/*.json`,
      `${generatedManifestPath}`,
    ],
    {
      absolute: true,
      cwd: context.rootDir,
      onlyFiles: true,
    },
  );

  for (const filePath of generatedFiles.map(normalizeAbsolutePath)) {
    if (context.expectedFiles.has(filePath)) {
      continue;
    }

    await rm(filePath, { force: true });
    context.changed = true;
  }
}

function createManifest(options: {
  checkerEntries: Map<string, string>;
  checkers: ReturnType<typeof getActiveCheckers>;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  generatedKnipDiagnostics: GeneratedKnipPackageDiagnostic[];
  generatedKnipPackageConfigs: GeneratedKnipPackageConfig[];
  projectsByChecker: Map<string, SourceProject[]>;
  providerEdges: GeneratedProviderEdge[];
  rootDir: string;
  sourceToBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
}): GeneratedTsconfigGraphManifest {
  const manifestCheckers: Record<string, GeneratedCheckerManifest> = {};

  for (const checker of options.checkers) {
    const projects = options.projectsByChecker.get(checker.name) ?? [];
    const entryPath = options.checkerEntries.get(checker.name);
    const configToOutputBuildByConfigPath =
      options.configToOutputBuildByChecker.get(checker.name) ?? new Map();
    const sourceToBuildBySourcePath =
      options.sourceToBuildByChecker.get(checker.name) ?? new Map();

    if (!entryPath) {
      continue;
    }

    const configToOutputBuild: Record<string, GeneratedBuildModuleManifest> =
      {};
    const sourceToBuild: Record<string, GeneratedBuildModuleManifest> = {};
    const sourceToDts: Record<string, string> = {};
    const dtsToSource: Record<string, string> = {};

    for (const [
      sourceConfigPath,
      outputModule,
    ] of configToOutputBuildByConfigPath) {
      const sourcePath = toPosixPath(
        toRelativePath(options.rootDir, sourceConfigPath),
      );

      configToOutputBuild[sourcePath] = {
        kind: outputModule.kind,
        path: toPosixPath(toRelativePath(options.rootDir, outputModule.path)),
      };
    }

    for (const [sourceConfigPath, buildModule] of sourceToBuildBySourcePath) {
      const sourcePath = toPosixPath(
        toRelativePath(options.rootDir, sourceConfigPath),
      );

      sourceToBuild[sourcePath] = {
        kind: buildModule.kind,
        path: toPosixPath(toRelativePath(options.rootDir, buildModule.path)),
      };
    }

    for (const project of projects) {
      const sourcePath = toPosixPath(
        toRelativePath(options.rootDir, project.configPath),
      );
      const dtsPath = toPosixPath(
        toRelativePath(options.rootDir, project.dtsConfigPath),
      );

      sourceToDts[sourcePath] = dtsPath;
      dtsToSource[dtsPath] = sourcePath;
    }

    manifestCheckers[checker.name] = {
      configToOutputBuild: Object.fromEntries(
        Object.entries(configToOutputBuild).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      preset: checker.preset,
      entry: toPosixPath(toRelativePath(options.rootDir, entryPath)),
      roots: projects
        .map((project) =>
          toPosixPath(toRelativePath(options.rootDir, project.configPath)),
        )
        .sort(),
      sourceToBuild: Object.fromEntries(
        Object.entries(sourceToBuild).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      sourceToDts,
      dtsToSource,
    };
  }

  return {
    version: 2,
    generatedBy: 'limina',
    checkers: manifestCheckers,
    knip: {
      diagnostics: options.generatedKnipDiagnostics,
      packages: options.generatedKnipPackageConfigs,
    },
    providerEdges: options.providerEdges.map((edge) => ({
      file: edge.file,
      fromChecker: edge.fromChecker,
      fromConfig: toPosixPath(
        toRelativePath(options.rootDir, edge.fromConfigPath),
      ),
      importedSpecifier: edge.importedSpecifier,
      resolvedFile: toPosixPath(
        toRelativePath(options.rootDir, edge.resolvedFilePath),
      ),
      toChecker: edge.toChecker,
      toConfig: toPosixPath(toRelativePath(options.rootDir, edge.toConfigPath)),
    })),
  };
}

function createResult(options: {
  changed: boolean;
  checkers: ResolvedCheckerConfig[];
  manifest: GeneratedTsconfigGraphManifest;
  manifestPath: string;
  outputDeclarationCopiesByChecker: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >;
  rootDir: string;
}): GeneratedTsconfigGraphResult {
  const checkerEntries = new Map<string, string>();
  const configToOutputBuild = new Map<
    string,
    Map<string, GeneratedBuildModule>
  >();
  const sourceToBuild = new Map<string, Map<string, GeneratedBuildModule>>();
  const sourceToDts = new Map<string, Map<string, string>>();
  const dtsToSource = new Map<string, Map<string, string>>();
  const providerEdges = options.manifest.providerEdges.map((edge) => ({
    file: edge.file,
    fromChecker: edge.fromChecker,
    fromConfigPath: normalizeAbsolutePath(
      path.join(options.rootDir, edge.fromConfig),
    ),
    importedSpecifier: edge.importedSpecifier,
    resolvedFilePath: normalizeAbsolutePath(
      path.join(options.rootDir, edge.resolvedFile),
    ),
    toChecker: edge.toChecker,
    toConfigPath: normalizeAbsolutePath(
      path.join(options.rootDir, edge.toConfig),
    ),
  }));

  for (const [checkerName, checkerManifest] of Object.entries(
    options.manifest.checkers,
  )) {
    checkerEntries.set(
      checkerName,
      normalizeAbsolutePath(path.join(options.rootDir, checkerManifest.entry)),
    );

    configToOutputBuild.set(
      checkerName,
      new Map(
        Object.entries(checkerManifest.configToOutputBuild ?? {}).map(
          ([sourcePath, buildModule]) => [
            normalizeAbsolutePath(path.join(options.rootDir, sourcePath)),
            {
              kind: buildModule.kind,
              path: normalizeAbsolutePath(
                path.join(options.rootDir, buildModule.path),
              ),
            },
          ],
        ),
      ),
    );
    sourceToBuild.set(
      checkerName,
      new Map(
        Object.entries(checkerManifest.sourceToBuild ?? {}).map(
          ([sourcePath, buildModule]) => [
            normalizeAbsolutePath(path.join(options.rootDir, sourcePath)),
            {
              kind: buildModule.kind,
              path: normalizeAbsolutePath(
                path.join(options.rootDir, buildModule.path),
              ),
            },
          ],
        ),
      ),
    );
    sourceToDts.set(
      checkerName,
      new Map(
        Object.entries(checkerManifest.sourceToDts).map(
          ([sourcePath, dtsPath]) => [
            normalizeAbsolutePath(path.join(options.rootDir, sourcePath)),
            normalizeAbsolutePath(path.join(options.rootDir, dtsPath)),
          ],
        ),
      ),
    );
    dtsToSource.set(
      checkerName,
      new Map(
        Object.entries(checkerManifest.dtsToSource).map(
          ([dtsPath, sourcePath]) => [
            normalizeAbsolutePath(path.join(options.rootDir, dtsPath)),
            normalizeAbsolutePath(path.join(options.rootDir, sourcePath)),
          ],
        ),
      ),
    );
  }

  return {
    changed: options.changed,
    checkers: options.checkers,
    manifestPath: options.manifestPath,
    checkerEntries,
    configToOutputBuild,
    outputDeclarationCopies: new Map(
      [...options.outputDeclarationCopiesByChecker.entries()].map(
        ([checkerName, copyContextsBySourcePath]) => [
          checkerName,
          new Map(
            [...copyContextsBySourcePath.entries()].map(
              ([sourceConfigPath, copyContexts]) => [
                sourceConfigPath,
                copyContexts.map((copyContext) => ({ ...copyContext })),
              ],
            ),
          ),
        ],
      ),
    ),
    sourceToBuild,
    sourceToDts,
    dtsToSource,
    generatedKnipConfigs: resolveGeneratedKnipPackageConfigs({
      configs: options.manifest.knip?.packages ?? [],
      rootDir: options.rootDir,
    }),
    generatedKnipDiagnostics: resolveGeneratedKnipPackageDiagnostics({
      diagnostics: options.manifest.knip?.diagnostics ?? [],
      rootDir: options.rootDir,
    }),
    providerEdges,
    manifest: options.manifest,
  };
}

export function collectGeneratedSourceConfigPaths(
  generatedGraph: GeneratedTsconfigGraphResult,
): string[] {
  return uniqueSortedStrings(
    [...generatedGraph.sourceToBuild.values()].flatMap((sourceToBuild) => [
      ...sourceToBuild.keys(),
    ]),
  );
}

export async function prepareGeneratedTsconfigGraph(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions = {},
): Promise<GeneratedTsconfigGraphResult> {
  const checkers = await resolveGeneratedGraphCheckers(config, options);
  const checkerCollectionsByName = new Map<
    string,
    CheckerSourceConfigCollection
  >();
  const configToOutputBuildByChecker = new Map<
    string,
    Map<string, GeneratedBuildModule>
  >();
  const outputDeclarationCopiesByChecker = new Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >();
  const outputProjectsByChecker = new Map<string, SourceProject[]>();
  const outputSolutionsByChecker = new Map<string, OutputSolutionProject[]>();
  const projectsByChecker = new Map<string, SourceProject[]>();
  const rootBuildPathsByChecker = new Map<string, string[]>();
  const solutionsByChecker = new Map<string, SolutionProject[]>();
  const checkerEntries = new Map<string, string>();
  const sourceToBuildByChecker = new Map<
    string,
    Map<string, GeneratedBuildModule>
  >();
  const providerEdges: GeneratedProviderEdge[] = [];
  const writeContext: GeneratedGraphWriteContext = {
    changed: false,
    expectedFiles: new Set(),
    rootDir: config.rootDir,
  };
  const problems: string[] = [];

  const preparedCheckers = await Promise.all(
    checkers.map(async (checker): Promise<PreparedCheckerGraph> => {
      const collection = await collectCheckerSourceConfigs(
        config,
        checker.name,
        checker.include,
        checker.exclude,
      );
      const projects = [...collection.projectConfigPaths]
        .sort()
        .map((sourceConfigPath) =>
          createSourceProject({
            checkerName: checker.name,
            checkerPreset: checker.preset,
            config,
            sourceConfigPath,
          }),
        );
      const solutions = [...collection.solutionConfigPaths]
        .sort()
        .map((sourceConfigPath) =>
          createSolutionProject({
            checkerName: checker.name,
            collection,
            config,
            sourceConfigPath,
          }),
        );

      const rootBuildPaths = collection.rootConfigPaths
        .map(
          (sourceConfigPath) =>
            collection.buildModulesBySourcePath.get(sourceConfigPath)?.path,
        )
        .filter((buildPath): buildPath is string => Boolean(buildPath));

      return {
        checker,
        collection,
        entryPath: getGeneratedCheckerEntryPath({
          checkerName: checker.name,
          rootDir: config.rootDir,
        }),
        projects,
        rootBuildPaths,
        solutions,
      };
    }),
  );

  for (const preparedChecker of preparedCheckers) {
    checkerCollectionsByName.set(
      preparedChecker.checker.name,
      preparedChecker.collection,
    );
    projectsByChecker.set(
      preparedChecker.checker.name,
      preparedChecker.projects,
    );
    solutionsByChecker.set(
      preparedChecker.checker.name,
      preparedChecker.solutions,
    );
    sourceToBuildByChecker.set(
      preparedChecker.checker.name,
      preparedChecker.collection.buildModulesBySourcePath,
    );
    rootBuildPathsByChecker.set(
      preparedChecker.checker.name,
      preparedChecker.rootBuildPaths,
    );
    checkerEntries.set(preparedChecker.checker.name, preparedChecker.entryPath);
  }

  addOverlappingCheckerEntryProblems({
    checkerCollectionsByName,
    checkers,
    problems,
    rootDir: config.rootDir,
  });
  addDuplicateCheckerOwnershipProblems({
    checkerCollectionsByName,
    checkers,
    problems,
    rootDir: config.rootDir,
  });

  const allProjects = [...projectsByChecker.values()].flat();

  addUnsupportedSourceConfigExtensionProblems({
    config,
    problems,
    projects: allProjects,
  });

  const inferredReferenceCollections = await Promise.all(
    checkers.map((checker) =>
      inferProjectReferences(
        config,
        projectsByChecker.get(checker.name) ?? [],
        allProjects,
        options,
      ),
    ),
  );

  for (const collection of inferredReferenceCollections) {
    problems.push(...collection.problems);
    providerEdges.push(...collection.providerEdges);
  }

  addCrossCheckerProviderCompatibilityProblems({
    config,
    problems,
    projects: allProjects,
    providerEdges,
  });

  const allProjectsByDtsPath = createSourceProjectsByDtsPath(allProjects);

  for (const checker of checkers) {
    const outputGraph = createCheckerOutputGraph({
      allProjectsByDtsPath,
      checker,
      collection: checkerCollectionsByName.get(checker.name) ?? {
        buildModulesBySourcePath: new Map(),
        entryConfigPaths: new Set(),
        projectConfigPaths: new Set(),
        rootConfigPaths: [],
        solutionConfigPaths: new Set(),
        solutionReferencesBySourcePath: new Map(),
      },
      config,
      problems,
      projects: projectsByChecker.get(checker.name) ?? [],
    });

    configToOutputBuildByChecker.set(
      checker.name,
      outputGraph.configToOutputBuild,
    );
    outputDeclarationCopiesByChecker.set(
      checker.name,
      outputGraph.outputDeclarationCopies,
    );
    outputProjectsByChecker.set(checker.name, outputGraph.outputProjects);
    outputSolutionsByChecker.set(checker.name, outputGraph.outputSolutions);
  }

  providerEdges.sort(
    (left, right) =>
      left.fromChecker.localeCompare(right.fromChecker) ||
      left.fromConfigPath.localeCompare(right.fromConfigPath) ||
      left.toChecker.localeCompare(right.toChecker) ||
      left.toConfigPath.localeCompare(right.toConfigPath) ||
      left.file.localeCompare(right.file) ||
      left.importedSpecifier.localeCompare(right.importedSpecifier),
  );

  if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config,
      fallback: 'Failed to prepare generated tsconfig graph.',
      problems,
    });
  }

  const workspacePackages = options.workspacePackagesProvider
    ? await options.workspacePackagesProvider()
    : await collectWorkspacePackages(config);
  const generatedKnip = prepareGeneratedKnipPackageConfigs({
    checkers,
    configToOutputBuildByChecker,
    config,
    workspacePackages,
  });

  await Promise.all(
    checkers.map(async (checker) => {
      const checkerName = checker.name;
      const projects = projectsByChecker.get(checkerName) ?? [];
      const entryPath = checkerEntries.get(checkerName);
      const outputProjects = outputProjectsByChecker.get(checkerName) ?? [];
      const outputSolutions = outputSolutionsByChecker.get(checkerName) ?? [];
      const solutions = solutionsByChecker.get(checkerName) ?? [];
      const rootBuildPaths = rootBuildPathsByChecker.get(checkerName) ?? [];

      if (!entryPath) {
        return;
      }

      await Promise.all([
        ...projects.map((project) =>
          writeGeneratedJson(
            writeContext,
            project.dtsConfigPath,
            createGeneratedDtsConfig(config, project),
          ),
        ),
        ...solutions.map((solution) =>
          writeGeneratedJson(
            writeContext,
            solution.buildConfigPath,
            createGeneratedSolutionBuildConfig(config, solution),
          ),
        ),
        ...outputProjects.map((project) =>
          writeGeneratedJson(
            writeContext,
            project.outputConfigPath,
            createGeneratedOutputProjectConfig(config, project),
          ),
        ),
        ...outputSolutions.map((solution) =>
          writeGeneratedJson(
            writeContext,
            solution.buildConfigPath,
            createGeneratedOutputSolutionConfig(config, solution),
          ),
        ),
        writeGeneratedJson(
          writeContext,
          entryPath,
          createCheckerBuildConfig({
            checkerName,
            entryPath,
            references: rootBuildPaths,
            rootDir: config.rootDir,
          }),
        ),
      ]);
    }),
  );

  await Promise.all(
    generatedKnip.configs.map((entry) =>
      writeGeneratedJson(writeContext, entry.configPath, entry.content),
    ),
  );

  const manifest = createManifest({
    checkerEntries,
    checkers,
    configToOutputBuildByChecker,
    generatedKnipDiagnostics: generatedKnip.diagnostics,
    generatedKnipPackageConfigs: generatedKnip.configs.map(
      (entry) => entry.config,
    ),
    projectsByChecker,
    providerEdges,
    rootDir: config.rootDir,
    sourceToBuildByChecker,
  });
  const manifestPath = normalizeAbsolutePath(
    path.join(config.rootDir, generatedManifestPath),
  );

  await writeGeneratedJson(writeContext, manifestPath, manifest);
  await removeStaleGeneratedFiles(writeContext);

  return createResult({
    changed: writeContext.changed,
    checkers,
    manifest,
    manifestPath,
    outputDeclarationCopiesByChecker,
    rootDir: config.rootDir,
  });
}
