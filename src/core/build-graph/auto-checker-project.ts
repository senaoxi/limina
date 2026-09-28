import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  getBuildCheckerSupportedExtensions,
  isBuildCapablePreset,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { getRawReferencePaths } from '../tsconfig/actions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  addExplicitVueFiles,
  getExplicitAnalysisGeneration,
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
  config: ResolvedLiminaConfig;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): NeutralProjectEvidence {
  const context: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions: capabilityDiscoveryExtensions,
  };
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
  });
  const fileNames = parsed.fileNames.map(normalizeAbsolutePath).sort();
  return {
    context,
    fileNames,
    parsed,
    partition: partitionSourceFiles(fileNames),
  };
}

function isVueIntentHint(hint: FrameworkIntentHint): boolean {
  return hint.family === 'vue';
}

function hasVueCandidate(
  neutral: NeutralProjectEvidence,
  intentHints: readonly FrameworkIntentHint[],
): boolean {
  if (neutral.partition.vueFiles.length > 0) return true;
  return intentHints.some(isVueIntentHint);
}

function parseVueProject(options: {
  config: ResolvedLiminaConfig;
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
  if (parsed === undefined) return [];
  return parsed.fileNames;
}

function getSemanticVueFileNames(
  parsed: ParsedCheckerProject | undefined,
): string[] | null {
  const identity = parsed?.vueSemanticIdentity;
  if (identity === undefined) return null;
  return [...identity.profilesByFileName.keys()].sort();
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
  config: ResolvedLiminaConfig;
  configPath: string;
  intentHints: readonly FrameworkIntentHint[];
  packageRootDir: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScopeProject {
  const neutral = parseNeutralProject(options);
  const vue = parseVueProject({
    ...options,
    enabled: hasVueCandidate(neutral, options.intentHints),
  });
  const vueFileNames = collectVueFileNames(vue.parsed);
  const fileNames = [
    ...new Set([...neutral.fileNames, ...vueFileNames]),
  ].sort();
  const filePartition = partitionSourceFiles(fileNames);
  filePartition.vueFiles = [
    ...new Set([...filePartition.vueFiles, ...vueFileNames]),
  ].sort();
  return {
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
    references: getRawReferencePaths(options.config, options.configPath).map(
      (referencePath) => ({ path: referencePath }),
    ),
  };
}

function getScopedParseContext(
  checkerName: CheckerName,
): CheckerProjectParseContext {
  if (isBuildCapablePreset(checkerName)) {
    return { checkerPresets: [checkerName], extensions: [] };
  }
  return {
    checkerPresets: ['tsc'],
    extensions: checkerName === 'astro' ? ['.astro'] : ['.svelte'],
  };
}

export function createExplicitScopeProject(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: CheckerName;
  config: ResolvedLiminaConfig;
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
  });
  const fileNames = parsed.fileNames.map(normalizeAbsolutePath).sort();
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
    references: getRawReferencePaths(options.config, options.configPath).map(
      (referencePath) => ({ path: referencePath }),
    ),
  };
}
