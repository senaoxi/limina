import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createExtensionPattern,
  getDtsCompanionConfigPath,
  getRawReferencePaths,
  isDtsConfigPath,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { isNonEmptyString } from '#utils/values';
import path from 'pathe';
import { readProjectGraphRules } from './project-labels';
import type { ProjectInfo } from './project-types';

export function isDtsProjectConfig(configPath: string): boolean {
  return isDtsConfigPath(configPath);
}

export function getTypecheckConfigPath(dtsConfigPath: string): string {
  return getDtsCompanionConfigPath(dtsConfigPath);
}

function createDefaultParseContext(): CheckerProjectParseContext {
  return { checkerPresets: [], extensions: [] };
}

function resolveParseContext(
  contextOrExtensions: CheckerProjectParseContext | string[] | undefined,
): CheckerProjectParseContext {
  if (Array.isArray(contextOrExtensions)) {
    return { checkerPresets: [], extensions: contextOrExtensions };
  }

  return contextOrExtensions ?? createDefaultParseContext();
}

function getVirtualContent(
  virtualFiles: ReadonlyMap<string, string> | undefined,
  configPath: string,
): string | undefined {
  return virtualFiles?.get(normalizeAbsolutePath(configPath));
}

function parseGeneratedSourceConfig(
  configPath: string,
  virtualContent: string,
): string {
  const configObject = JSON.parse(virtualContent) as {
    liminaOptions?: { readonly sourceConfig?: unknown };
  };
  const sourceConfig = configObject.liminaOptions?.sourceConfig;

  if (!isNonEmptyString(sourceConfig)) {
    throw new Error(
      `Generated declaration config "${configPath}" has no sourceConfig.`,
    );
  }

  return sourceConfig;
}

function getProjectResolverConfigPath(
  configPath: string,
  virtualFiles: ReadonlyMap<string, string> | undefined,
): string {
  const virtualContent = getVirtualContent(virtualFiles, configPath);

  if (virtualContent === undefined) {
    return getTypecheckConfigPath(configPath);
  }

  return resolveReferencePath(
    configPath,
    parseGeneratedSourceConfig(configPath, virtualContent),
  );
}

function resolveVirtualReferencePath(options: {
  configPath: string;
  reference: { readonly path?: unknown };
}): string[] {
  if (typeof options.reference.path !== 'string') {
    return [];
  }

  return [
    normalizeAbsolutePath(
      path.resolve(path.dirname(options.configPath), options.reference.path),
    ),
  ];
}

function getProjectReferencePaths(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  virtualFiles: ReadonlyMap<string, string> | undefined;
}): string[] {
  const virtualContent = getVirtualContent(
    options.virtualFiles,
    options.configPath,
  );

  if (virtualContent === undefined) {
    return getRawReferencePaths(options.config, options.configPath);
  }

  const configObject = JSON.parse(virtualContent) as {
    references?: readonly { readonly path?: unknown }[];
  };
  return (configObject.references ?? []).flatMap((reference) =>
    resolveVirtualReferencePath({
      configPath: options.configPath,
      reference,
    }),
  );
}

function normalizeProjectFileNames(options: {
  extensions: readonly string[];
  fileNames: readonly string[];
}): string[] {
  const filePattern = createExtensionPattern([...options.extensions]);
  return options.fileNames
    .filter((fileName) => filePattern.test(fileName))
    .map(normalizeAbsolutePath);
}

function resolveOwnedParsedProject(options: {
  config: ResolvedLiminaConfig;
  context: CheckerProjectParseContext;
  normalizedConfigPath: string;
  parsed: ReturnType<typeof parseCheckerProjectConfigForContext>;
  resolverConfigPath: string;
  virtualFiles: ReadonlyMap<string, string> | undefined;
}): ReturnType<typeof parseCheckerProjectConfigForContext> {
  if (options.resolverConfigPath === options.normalizedConfigPath) {
    return options.parsed;
  }

  return parseCheckerProjectConfigForContext({
    configPath: options.resolverConfigPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });
}

type ParseProjectArgs = [
  config: ResolvedLiminaConfig,
  configPath: string,
  contextOrExtensions?: CheckerProjectParseContext | string[],
  virtualFiles?: ReadonlyMap<string, string>,
];

export function parseProject(...args: ParseProjectArgs): ProjectInfo {
  const [config, configPath, contextOrExtensions, virtualFiles] = args;
  const context = resolveParseContext(contextOrExtensions);
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
    virtualFiles,
  });
  const normalizedConfigPath = normalizeAbsolutePath(configPath);
  const resolverConfigPath = isDtsProjectConfig(normalizedConfigPath)
    ? getProjectResolverConfigPath(normalizedConfigPath, virtualFiles)
    : normalizedConfigPath;
  const ownedParsed = resolveOwnedParsedProject({
    config,
    context,
    normalizedConfigPath,
    parsed,
    resolverConfigPath,
    virtualFiles,
  });
  const labelInfo = readProjectGraphRules({
    config,
    configPath,
    virtualFiles,
  });

  return {
    checkerPresets: context.checkerPresets,
    configPath: normalizedConfigPath,
    extensions: parsed.extensions,
    fileNames: normalizeProjectFileNames({
      extensions: parsed.extensions,
      fileNames: parsed.fileNames,
    }),
    labelDiagnostic: labelInfo.labelDiagnostic,
    labels: labelInfo.labels,
    labelProblem: labelInfo.labelProblem,
    ownedFileNames: normalizeProjectFileNames({
      extensions: parsed.extensions,
      fileNames: ownedParsed.fileNames,
    }),
    options: parsed.options,
    references: new Set(
      getProjectReferencePaths({ config, configPath, virtualFiles }),
    ),
    resolverConfigPath,
  };
}
