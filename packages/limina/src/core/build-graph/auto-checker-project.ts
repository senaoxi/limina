import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { isLiminaSolutionConfig, readJsonConfig } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { getRawReferencePaths } from '../tsconfig/actions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './generated/file-extensions';
import { partitionSourceFiles } from './source-capabilities';
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

const discoveryExtensions = {
  'vue-tsc': ['.vue'],
  'svelte-check': ['.svelte'],
  astro: ['.astro'],
  tsc: [],
  tsgo: [],
} as const satisfies Record<CheckerName, readonly string[]>;

export function parseNeutralProject(options: {
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): NeutralProjectEvidence {
  const context: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions:
      options.checkerName === undefined
        ? capabilityDiscoveryExtensions
        : [...discoveryExtensions[options.checkerName]],
  };
  let parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  const customExtensions =
    options.checkerName === undefined || options.checkerName === 'vue-tsc'
      ? (parsed.configuredVueExtensions ?? [])
      : [];
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
function getPackageRootForFile(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  fallbackPackageRootDir: string;
  fileName: string;
}): string {
  const region = options.activatedRegions.findPackageForPath(options.fileName);
  return region === null ? options.fallbackPackageRootDir : region.directory;
}

export function createScopeProject(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  packageRootDir: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScopeProject {
  const context: CheckerProjectParseContext = {
    checkerPresets: [options.checkerName === 'tsgo' ? 'tsgo' : 'tsc'],
    extensions: [],
  };
  const native = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  const isNativeScope =
    options.checkerName === 'tsc' ||
    options.checkerName === 'tsgo' ||
    (options.checkerName === undefined &&
      isLiminaSolutionConfig({
        configPath: options.configPath,
        configObject: readJsonConfig(options.config, options.configPath),
        fileNames: native.fileNames,
      }));
  const {
    parsed,
    fileNames,
    partition,
    context: selectedContext,
  } = isNativeScope
    ? {
        parsed: native,
        fileNames: native.fileNames,
        partition: partitionSourceFiles(native.fileNames),
        context,
      }
    : parseNeutralProject(options);
  return {
    analysisGeneration: options.projectConfigCache?.generation ?? 0,
    configClosure: parsed.configClosure,
    configPath: options.configPath,
    context: selectedContext,
    fileNames,
    filePartition: partition,
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
