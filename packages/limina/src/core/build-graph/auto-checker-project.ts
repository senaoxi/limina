import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  getBuildCheckerSupportedExtensions,
  isNativeTypeScriptProjectInput,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { isLiminaSolutionConfig, readJsonConfig } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { getRawReferencePaths } from '../tsconfig/actions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  addExplicitVueFiles,
  getExplicitAnalysisGeneration,
  getScopedParseContext,
  getVueProfileFileNames,
} from './explicit-checker-project-helpers';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './generated/file-extensions';
import {
  type FrameworkIntentHint,
  partitionSourceFiles,
} from './source-capabilities';
import type { AutoScopeProject } from './types';

type ParsedCheckerProject = ReturnType<
  typeof parseCheckerProjectConfigForContext
>;

interface NeutralProjectEvidence {
  context: CheckerProjectParseContext;
  fileNames: string[];
  parsed: ParsedCheckerProject;
  partition: ReturnType<typeof partitionSourceFiles>;
}

interface VueProjectEvidence {
  context: CheckerProjectParseContext;
  parsed: ParsedCheckerProject | undefined;
}
function parseNeutralProject(options: {
  config: ResolvedLiminaInputs;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): NeutralProjectEvidence {
  const context: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions: capabilityDiscoveryExtensions,
  };
  let parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  const customExtensions = configuredVueExtensions(
    options.config,
    parsed,
    options.configPath,
  );
  if (customExtensions.length > 0) {
    context.extensions = [
      ...new Set([...context.extensions, ...customExtensions]),
    ];
    parsed = parseCheckerProjectConfigForContext({
      allowNoInputDiagnostics: true,
      cache: options.projectConfigCache,
      configPath: options.configPath,
      context,
      projectRootDir: options.config.rootDir,
      virtualFiles: options.config.virtualFiles,
    });
  }
  const fileNames = parsed.fileNames
    .map(normalizeAbsolutePath)
    .sort(compareCodeUnits);
  const partition = partitionSourceFiles(fileNames);
  partition.vueFiles = [
    ...new Set([
      ...partition.vueFiles,
      ...fileNames.filter((file) =>
        customExtensions.includes(getFileExtension(file)),
      ),
    ]),
  ].sort(compareCodeUnits);
  return { context, fileNames, parsed, partition };
}
function configuredVueExtensions(
  config: ResolvedLiminaInputs,
  parsed: ParsedCheckerProject,
  configPath: string,
): string[] {
  const byKey = new Map<string, string[]>();
  const configFile = parsed.options.configFile;
  const paths: string[] =
    isPlainRecord(configFile) && Array.isArray(configFile.extendedSourceFiles)
      ? configFile.extendedSourceFiles
          .filter((value): value is string => typeof value === 'string')
          .toReversed()
      : [];
  paths.push(configPath);
  for (const filePath of paths) {
    const value = readJsonConfig(config, filePath).vueCompilerOptions;
    if (!isPlainRecord(value)) continue;
    for (const key of [
      'extensions',
      'petiteVueExtensions',
      'vitePressExtensions',
    ] as const) {
      if (!Object.hasOwn(value, key)) continue;
      const configured = value[key];
      if (Array.isArray(configured))
        byKey.set(
          key,
          configured.filter((item): item is string => typeof item === 'string'),
        );
    }
  }
  return [...new Set(byKey.values().toArray().flat())];
}

function initialFrameworkCheckers(
  neutral: NeutralProjectEvidence,
  hints: readonly FrameworkIntentHint[],
): string[] {
  const families = new Set(hints.map((hint) => hint.family));
  if (neutral.partition.astroFiles.length > 0) families.add('astro');
  if (neutral.partition.svelteFiles.length > 0) families.add('svelte');
  if (neutral.partition.vueFiles.length > 0) families.add('vue');
  return [...families];
}

function parseVueProject(options: {
  config: ResolvedLiminaInputs;
  configPath: string;
  enabled: boolean;
  projectConfigCache?: CheckerProjectConfigCache;
}): VueProjectEvidence {
  if (!options.enabled) {
    return {
      context: { checkerPresets: ['vue-tsc'], extensions: [] },
      parsed: undefined,
    };
  }
  const parseContext: CheckerProjectParseContext = {
    checkerPresets: ['vue-tsc'],
    extensions: [],
  };
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context: parseContext,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  return {
    context: {
      ...parseContext,
      extensions: [...parsed.extensions],
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
    parsed,
  };
}

function getParsedFileNames(
  parsed: ParsedCheckerProject | undefined,
): readonly string[] {
  return parsed === undefined ? [] : parsed.fileNames;
}

function getSemanticVueFileNames(
  parsed: ParsedCheckerProject | undefined,
): string[] | null {
  const identity = parsed?.vueSemanticIdentity;
  return identity === undefined
    ? null
    : identity.profilesByFileName.keys().toArray().sort(compareCodeUnits);
}

function assertNoUnclassifiedVueMembers(fileNames: readonly string[]): void {
  if (fileNames.length === 0) return;
  throw new Error(
    'Vue project members were found without a Vue semantic identity.',
  );
}

function collectVueFileNames(
  parsed: ParsedCheckerProject | undefined,
): string[] {
  const semanticFileNames = getSemanticVueFileNames(parsed);
  if (semanticFileNames !== null) return semanticFileNames;
  const typeScriptExtensions = new Set(
    getBuildCheckerSupportedExtensions('tsc'),
  );
  const unclassified = getParsedFileNames(parsed)
    .map(normalizeAbsolutePath)
    .filter(
      (fileName) => !typeScriptExtensions.has(getFileExtension(fileName)),
    );
  assertNoUnclassifiedVueMembers(unclassified);
  return [];
}

function selectProjectContext(options: {
  neutral: NeutralProjectEvidence;
  vue: VueProjectEvidence;
  vueFileNames: readonly string[];
}): CheckerProjectParseContext {
  return options.vueFileNames.length > 0
    ? options.vue.context
    : options.neutral.context;
}

function selectProjectOptions(options: {
  neutral: NeutralProjectEvidence;
  vue: VueProjectEvidence;
}): ParsedCheckerProject['options'] {
  return options.vue.parsed?.options ?? options.neutral.parsed.options;
}

function selectProjectConfigClosure(options: {
  neutral: NeutralProjectEvidence;
  vue: VueProjectEvidence;
}): AutoScopeProject['configClosure'] {
  return (
    options.vue.parsed?.configClosure ?? options.neutral.parsed.configClosure
  ).map((entry) => ({ ...entry }));
}

function getPackageRootForFile(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  fallbackPackageRootDir: string;
  fileName: string;
}): string {
  const region = options.activatedRegions.findPackageForPath(options.fileName);
  return region === null ? options.fallbackPackageRootDir : region.directory;
}

export function createAutoScopeProject(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  configPath: string;
  intentHints: readonly FrameworkIntentHint[];
  packageRootDir: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScopeProject {
  const native = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context: { checkerPresets: ['tsc'], extensions: [] },
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  if (
    isLiminaSolutionConfig({
      configPath: options.configPath,
      configObject: readJsonConfig(options.config, options.configPath),
      fileNames: native.fileNames,
    })
  ) {
    return createExplicitScopeProject({ ...options, checkerName: 'tsc' });
  }
  const neutral = parseNeutralProject(options);
  const families = initialFrameworkCheckers(neutral, options.intentHints);
  let vue: VueProjectEvidence = {
    context: { checkerPresets: ['vue-tsc'], extensions: [] },
    parsed: undefined,
  };
  if (families.length === 1 && families[0] === 'vue') {
    try {
      vue = parseVueProject({ ...options, enabled: true });
    } catch {
      /*
      The selected checker retries through scoped Core collection.
      */
    }
  }
  const vueFileNames = collectVueFileNames(vue.parsed);
  const fileNames = [...new Set([...neutral.fileNames, ...vueFileNames])].sort(
    compareCodeUnits,
  );
  const filePartition = partitionSourceFiles(fileNames);
  filePartition.vueFiles = [
    ...new Set([...neutral.partition.vueFiles, ...vueFileNames]),
  ].sort(compareCodeUnits);
  const project: AutoScopeProject = {
    analysisGeneration: options.projectConfigCache?.generation ?? 0,
    configClosure: selectProjectConfigClosure({ neutral, vue }),
    configPath: options.configPath,
    context: selectProjectContext({ neutral, vue, vueFileNames }),
    fileNames,
    filePartition,
    options: selectProjectOptions({ neutral, vue }),
    packageRootByFileName: new Map(
      fileNames.map((fileName) => [
        fileName,
        getPackageRootForFile({
          activatedRegions: options.activatedRegions,
          fallbackPackageRootDir: options.packageRootDir,
          fileName,
        }),
      ]),
    ),
    packageRootDir: options.packageRootDir,
    virtualFiles: options.config.virtualFiles,
    references: getRawReferencePaths(options.config, options.configPath).map(
      (referencePath) => ({ path: referencePath }),
    ),
  };
  return project;
}

export function createExplicitScopeProject(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  packageRootDir: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScopeProject {
  const parseContext = getScopedParseContext(options.checkerName);
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context: parseContext,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  const fileNames = parsed.fileNames
    .map(normalizeAbsolutePath)
    .sort(compareCodeUnits);
  if (
    (options.checkerName === 'tsc' || options.checkerName === 'tsgo') &&
    fileNames.some((file) => !isNativeTypeScriptProjectInput(file))
  )
    throw new Error(
      `Native TypeScript cannot compile an explicitly selected root in ${options.configPath}.`,
    );
  const filePartition = partitionSourceFiles(fileNames);
  addExplicitVueFiles({
    checkerName: options.checkerName,
    filePartition,
    profileFileNames: getVueProfileFileNames(parsed.vueSemanticIdentity),
  });
  return {
    analysisGeneration: getExplicitAnalysisGeneration(
      options.projectConfigCache,
    ),
    configClosure: parsed.configClosure.map((entry) => ({ ...entry })),
    configPath: options.configPath,
    context: {
      ...parseContext,
      extensions: [...parsed.extensions],
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
    fileNames,
    filePartition,
    options: parsed.options,
    packageRootByFileName: new Map(
      fileNames.map((fileName) => [
        fileName,
        getPackageRootForFile({
          activatedRegions: options.activatedRegions,
          fallbackPackageRootDir: options.packageRootDir,
          fileName,
        }),
      ]),
    ),
    packageRootDir: options.packageRootDir,
    virtualFiles: options.config.virtualFiles,
    references: getRawReferencePaths(options.config, options.configPath).map(
      (referencePath) => ({ path: referencePath }),
    ),
  };
}
