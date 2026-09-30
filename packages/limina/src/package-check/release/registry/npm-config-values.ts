import { parse } from 'ini';
import { readFileSync } from 'node:fs';
import path from 'pathe';
import { RegistryAuthorityError } from './authority';

export interface RegistrySetting {
  readonly value: string;
  readonly source: string;
}
export type RegistrySettings = Map<string, RegistrySetting>;

function isRelevantKey(key: string): boolean {
  return (
    ['registry', 'userconfig', 'globalconfig', 'prefix'].includes(key) ||
    /^@[^:]+:registry$/u.test(key)
  );
}

function interpolateMatch(options: {
  match: string;
  escapes: string;
  name: string;
  environment: NodeJS.ProcessEnv;
  source: string;
}): string {
  if (options.escapes.length % 2 === 1) return options.match.slice(1);
  const value = options.environment[options.name];
  if (value === undefined)
    throw new RegistryAuthorityError(
      options.source,
      `environment variable ${options.name} is not defined`,
    );
  return options.escapes.slice(0, options.escapes.length / 2) + value;
}

function interpolate(
  value: string,
  environment: NodeJS.ProcessEnv,
  source: string,
): string {
  return value.replaceAll(
    /(\\*)\$\{([^}]+)\}/gu,
    (match: string, escapes: string, name: string) =>
      interpolateMatch({ match, escapes, name, environment, source }),
  );
}

function addSetting(options: {
  settings: RegistrySettings;
  key: string;
  value: unknown;
  environment: NodeJS.ProcessEnv;
  source: string;
}): void {
  const key = interpolate(
    options.key,
    options.environment,
    options.source,
  ).toLowerCase();
  if (!isRelevantKey(key)) return;
  if (typeof options.value !== 'string')
    throw new RegistryAuthorityError(options.source, `${key} must be a string`);
  options.settings.set(key, {
    value: interpolate(
      options.value.trim(),
      options.environment,
      options.source,
    ),
    source: options.source,
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function readOptionalRegistryFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new RegistryAuthorityError(
      filePath,
      'unable to read configuration file',
    );
  }
}

function readConfiguredFile(
  filePath: string,
  isRequired: boolean,
): string | undefined {
  const content = readOptionalRegistryFile(filePath);
  if (content === undefined && isRequired)
    throw new RegistryAuthorityError(
      filePath,
      'configuration file does not exist',
    );
  return content;
}

export function readNpmrc(options: {
  filePath: string;
  environment: NodeJS.ProcessEnv;
  layer: string;
  required: boolean;
}): RegistrySettings {
  const content = readConfiguredFile(options.filePath, options.required);
  if (content === undefined) return new Map();
  const source = `${options.layer}:${options.filePath}`;
  const values: Record<string, unknown> = parse(content);
  const settings: RegistrySettings = new Map();
  for (const [key, value] of Object.entries(values))
    addSetting({
      settings,
      key,
      value,
      environment: options.environment,
      source: `${source}#${key}`,
    });
  return settings;
}

function environmentKey(name: string): string {
  return name.slice('npm_config_'.length).replaceAll('_', '-').toLowerCase();
}

function isConfigEnvironmentEntry(
  name: string,
  value: string | undefined,
): boolean {
  return Boolean(value) && name.toLowerCase().startsWith('npm_config_');
}

export function readNpmEnvironment(
  environment: NodeJS.ProcessEnv,
): RegistrySettings {
  const settings: RegistrySettings = new Map();
  // npm scripts set lowercase keys; prefer those when both spellings exist.
  const entries = Object.entries(environment).sort(
    ([a], [b]) => Number(a === a.toLowerCase()) - Number(b === b.toLowerCase()),
  );
  for (const [name, value] of entries) {
    if (!isConfigEnvironmentEntry(name, value)) continue;
    addSetting({
      settings,
      key: environmentKey(name),
      value,
      environment,
      source: `env:${name}`,
    });
  }
  return settings;
}

export function resolveNpmConfigPath(options: {
  setting: RegistrySetting | undefined;
  fallback: string;
  home: string;
  cwd: string;
}): string {
  const value = configuredPathValue(options.setting, options.fallback);
  const expanded = isHomeRelativePath(value)
    ? path.join(options.home, value.slice(2))
    : value;
  return path.resolve(options.cwd, expanded);
}

function isHomeRelativePath(value: string): boolean {
  const prefix = process.platform === 'win32' ? /^~[/\\]/u : /^~\//u;
  return prefix.test(value);
}

function configuredPathValue(
  setting: RegistrySetting | undefined,
  fallback: string,
): string {
  return setting === undefined ? fallback : setting.value;
}
