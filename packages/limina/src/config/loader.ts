import { existsSync } from 'node:fs';
import path from 'pathe';
import { loadConfigModule } from './loader-import';
import {
  findLiminaConfigPath,
  formatDefaultConfigFileList,
  inferWorkspaceRoot,
  validateConfigPathInsideWorkspace,
} from './loader-paths';
import type {
  LiminaConfig,
  LiminaConfigEnv,
  LiminaConfigFn,
  LoadConfigOptions,
  ResolvedLiminaConfig,
} from './root-types';
import { normalizeConfig } from './runtime';

interface ConfigLocation {
  configPath: string;
  cwd: string;
  rootDir: string;
}

function getConfigCommand(
  options: LoadConfigOptions,
): LiminaConfigEnv['command'] {
  return options.command === undefined ? 'check' : options.command;
}

function getConfigMode(options: LoadConfigOptions): string {
  if (options.mode !== undefined) return options.mode;
  if (process.env.NODE_ENV !== undefined) return process.env.NODE_ENV;
  return 'default';
}

function createConfigEnv(options: LoadConfigOptions): LiminaConfigEnv {
  return {
    command: getConfigCommand(options),
    mode: getConfigMode(options),
  };
}

async function resolveConfigExport(
  configExport: unknown,
  configEnv: LiminaConfigEnv,
): Promise<LiminaConfig> {
  if (typeof configExport === 'function') {
    return normalizeConfig(await (configExport as LiminaConfigFn)(configEnv));
  }
  return normalizeConfig(await configExport);
}

function hasWorkspaceRootDependency(packageNames: readonly string[]): boolean {
  return packageNames.some((packageName) => packageName.trim().length > 0);
}

function ownerHasWorkspaceRootGrant(
  grants: readonly {
    workspaceRootDependencies: string[];
  }[],
): boolean {
  return grants.some((grant) =>
    hasWorkspaceRootDependency(grant.workspaceRootDependencies),
  );
}

function getImportAuthorityAllow(
  config: LiminaConfig,
): LiminaConfig['source'] extends infer Source
  ? Source extends { importAuthority?: infer Authority }
    ? Authority extends { allow?: infer Allow }
      ? Allow | undefined
      : undefined
    : undefined
  : undefined {
  const source = config.source;
  if (source === undefined) return undefined;
  const authority = source.importAuthority;
  if (authority === undefined) return undefined;
  return authority.allow;
}

function hasSourceImportAuthorityWorkspaceRootGrants(
  config: LiminaConfig,
): boolean {
  const allow = getImportAuthorityAllow(config);
  if (allow === undefined) return false;
  return Object.values(allow).some(ownerHasWorkspaceRootGrant);
}

function validateRootPackageImportAuthorityConfig(
  config: LiminaConfig,
  rootDir: string,
): void {
  if (!hasSourceImportAuthorityWorkspaceRootGrants(config)) return;
  if (existsSync(path.join(rootDir, 'package.json'))) return;
  throw new Error(
    [
      'Invalid source import authority config:',
      '  field: source.importAuthority.allow',
      '  reason: workspaceRootDependencies grants require a workspace root package.json.',
      '  fix: create a workspace root package.json, or remove workspaceRootDependencies grants.',
    ].join('\n'),
  );
}

function getCwd(options: LoadConfigOptions): string {
  return options.cwd === undefined ? process.cwd() : path.resolve(options.cwd);
}

function getExplicitConfigPath(
  options: LoadConfigOptions,
  cwd: string,
): string | undefined {
  if (options.configPath === undefined) return undefined;
  return path.resolve(cwd, options.configPath);
}

function getConfigRootDir(cwd: string, configPath: string | undefined): string {
  if (configPath === undefined) return inferWorkspaceRoot(cwd);
  return inferWorkspaceRoot(path.dirname(configPath));
}

function getResolvedConfigPath(options: {
  cwd: string;
  explicitConfigPath: string | undefined;
  rootDir: string;
}): string | null {
  if (options.explicitConfigPath !== undefined) {
    return options.explicitConfigPath;
  }
  return findLiminaConfigPath(options.cwd, options.rootDir);
}

function createMissingConfigError(options: {
  configPath: string | null;
  cwd: string;
  explicit: boolean;
  rootDir: string;
}): Error {
  if (options.explicit) {
    return new Error(`Unable to find limina config at ${options.configPath}`);
  }
  return new Error(
    `Unable to find limina config. Searched for ${formatDefaultConfigFileList()} from ${options.cwd} up to the pnpm workspace root at ${options.rootDir}.`,
  );
}

function requireConfigPath(options: {
  configPath: string | null;
  cwd: string;
  explicit: boolean;
  rootDir: string;
}): string {
  if (options.configPath !== null) {
    if (existsSync(options.configPath)) return options.configPath;
  }
  throw createMissingConfigError(options);
}

function resolveConfigLocation(options: LoadConfigOptions): ConfigLocation {
  const cwd = getCwd(options);
  const explicitConfigPath = getExplicitConfigPath(options, cwd);
  const rootDir = getConfigRootDir(cwd, explicitConfigPath);
  const candidate = getResolvedConfigPath({
    cwd,
    explicitConfigPath,
    rootDir,
  });
  if (candidate !== null) {
    validateConfigPathInsideWorkspace(candidate, rootDir);
  }
  return {
    configPath: requireConfigPath({
      configPath: candidate,
      cwd,
      explicit: explicitConfigPath !== undefined,
      rootDir,
    }),
    cwd,
    rootDir,
  };
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedLiminaConfig> {
  const location = resolveConfigLocation(options);
  const config = await resolveConfigExport(
    await loadConfigModule(location.configPath, options.configLoader),
    createConfigEnv(options),
  );
  validateRootPackageImportAuthorityConfig(config, location.rootDir);
  return {
    ...config,
    configPath: location.configPath,
    rootDir: location.rootDir,
  };
}
