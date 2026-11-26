import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { isLiminaSolutionConfig, readJsonConfig } from '#core/tsconfig/actions';
import { createExtraFileExtensions } from '../../checker/extensions';
import { parseTypeScriptCommandLine } from '../../checker/project-base';
import { capabilityDiscoveryExtensions } from './generated/file-extensions';

type ParsedCheckerProject = ReturnType<
  typeof parseCheckerProjectConfigForContext
>;

const discoveryExtensions = {
  'vue-tsc': ['.vue'],
  'svelte-check': ['.svelte'],
  astro: ['.astro'],
  tsc: [],
  tsgo: [],
} as const satisfies Record<CheckerName, readonly string[]>;

function parseNeutralProject(options: {
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): { parsed: ParsedCheckerProject } {
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
  return { parsed };
}

export function readSolutionRoleFileNames(options: {
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
}): readonly string[] {
  const extensions =
    options.checkerName === undefined
      ? []
      : [...discoveryExtensions[options.checkerName]];
  const parse = (extensions: string[]) =>
    parseTypeScriptCommandLine({
      roleOnly: true,
      extraFileExtensions: createExtraFileExtensions(extensions),
      parseOptions: {
        allowNoInputDiagnostics: true,
        configPath: options.configPath,
        projectRootDir: options.config.rootDir,
        virtualFiles: options.config.virtualFiles,
      },
    });
  const { parsed, configuredVueExtensions } = parse(extensions);
  return parsed.fileNames.length > 0 ||
    options.checkerName !== 'vue-tsc' ||
    configuredVueExtensions.length === 0
    ? parsed.fileNames
    : parse([...extensions, ...configuredVueExtensions]).parsed.fileNames;
}

function parseRoleProjectInputs(options: {
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): { parsed: ParsedCheckerProject } {
  if (
    options.checkerName !== undefined &&
    options.checkerName !== 'tsc' &&
    options.checkerName !== 'tsgo'
  )
    return parseNeutralProject(options);
  const context: CheckerProjectParseContext = {
    checkerPresets: [options.checkerName === 'tsgo' ? 'tsgo' : 'tsc'],
    extensions: [],
  };
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  });
  return { parsed };
}

export function parseScopeProjectInputs(options: {
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): { parsed: ParsedCheckerProject } {
  if (options.checkerName !== undefined) return parseRoleProjectInputs(options);
  const configObject = readJsonConfig(options.config, options.configPath);
  if (
    isLiminaSolutionConfig({
      configPath: options.configPath,
      configObject,
      fileNames: [],
    })
  ) {
    const native = parseRoleProjectInputs(options);
    if (native.parsed.fileNames.length === 0) return native;
  }
  return parseNeutralProject(options);
}
