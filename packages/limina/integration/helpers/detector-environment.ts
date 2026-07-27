import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
} from '../../src/package-check/release-registry-test-seam';
import { isPathInsideDirectory } from '../../src/utils/path';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const COPIED_HOST_ENVIRONMENT_KEYS = [
  'ComSpec',
  'LANG',
  'LC_ALL',
  'PATHEXT',
  'SystemRoot',
  'TERM',
  'TZ',
  'WINDIR',
] as const;
const RESERVED_KEYS = new Set([
  'HOME',
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
  'NODE_PATH',
  'NPM_CONFIG_CACHE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
]);

function isAbsolutePathEntry(entry: string): boolean {
  if (entry.length === 0) return false;
  return path.isAbsolute(entry);
}

function isWorkspacePathEntry(entry: string): boolean {
  const normalizedEntry = path.resolve(entry);
  if (normalizedEntry.includes(`${path.sep}node_modules${path.sep}.bin`)) {
    return true;
  }
  return isPathInsideDirectory(normalizedEntry, repositoryRoot);
}

function isUsableHostPathEntry(entry: string): boolean {
  if (!isAbsolutePathEntry(entry)) return false;
  return !isWorkspacePathEntry(entry);
}

function createSystemPath(toolBinDirectory: string): string {
  const hostEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(isUsableHostPathEntry);
  return [toolBinDirectory, ...hostEntries].join(path.delimiter);
}

function copyHostEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of COPIED_HOST_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function applyFixtureEnvironmentEntry(options: {
  environment: NodeJS.ProcessEnv;
  key: string;
  value: string;
}): void {
  if (RESERVED_KEYS.has(options.key.toUpperCase())) {
    throw new Error(
      `Detector fixture environment cannot override harness variable ${options.key}.`,
    );
  }
  options.environment[options.key] = options.value;
}

function applyFixtureEnvironment(options: {
  environment: NodeJS.ProcessEnv;
  fixtureEnvironment: Readonly<Record<string, string>> | undefined;
}): void {
  if (options.fixtureEnvironment === undefined) return;
  for (const [key, value] of Object.entries(options.fixtureEnvironment)) {
    applyFixtureEnvironmentEntry({
      environment: options.environment,
      key,
      value,
    });
  }
}

async function createSandboxDirectories(sandboxRoot: string): Promise<{
  cacheDirectory: string;
  homeDirectory: string;
  tempDirectory: string;
}> {
  const homeDirectory = path.join(sandboxRoot, 'home');
  const cacheDirectory = path.join(sandboxRoot, 'cache');
  const tempDirectory = path.join(sandboxRoot, 'tmp');
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(tempDirectory, { recursive: true }),
  ]);
  return { cacheDirectory, homeDirectory, tempDirectory };
}

export async function createDetectorInvocationEnvironment(options: {
  readonly fixtureEnvironment?: Readonly<Record<string, string>>;
  readonly sandboxRoot: string;
  readonly toolBinDirectory: string;
}): Promise<NodeJS.ProcessEnv> {
  const directories = await createSandboxDirectories(options.sandboxRoot);
  const environment = copyHostEnvironment();
  applyFixtureEnvironment({
    environment,
    fixtureEnvironment: options.fixtureEnvironment,
  });
  return {
    ...environment,
    HOME: directories.homeDirectory,
    npm_config_cache: directories.cacheDirectory,
    PATH: createSystemPath(options.toolBinDirectory),
    TEMP: directories.tempDirectory,
    TMP: directories.tempDirectory,
    TMPDIR: directories.tempDirectory,
    USERPROFILE: directories.homeDirectory,
    XDG_CACHE_HOME: directories.cacheDirectory,
  };
}
