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

function createSystemPath(toolBinDirectory: string): string {
  const hostEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => {
      if (!entry || !path.isAbsolute(entry)) {
        return false;
      }
      const normalizedEntry = path.resolve(entry);
      return (
        !normalizedEntry.includes(`${path.sep}node_modules${path.sep}.bin`) &&
        !isPathInsideDirectory(normalizedEntry, repositoryRoot)
      );
    });

  return [toolBinDirectory, ...hostEntries].join(path.delimiter);
}

export async function createDetectorInvocationEnvironment(options: {
  readonly fixtureEnvironment?: Readonly<Record<string, string>>;
  readonly sandboxRoot: string;
  readonly toolBinDirectory: string;
}): Promise<NodeJS.ProcessEnv> {
  const homeDirectory = path.join(options.sandboxRoot, 'home');
  const cacheDirectory = path.join(options.sandboxRoot, 'cache');
  const tempDirectory = path.join(options.sandboxRoot, 'tmp');
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(tempDirectory, { recursive: true }),
  ]);

  const environment: NodeJS.ProcessEnv = {};
  for (const key of COPIED_HOST_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(options.fixtureEnvironment ?? {})) {
    if (RESERVED_KEYS.has(key.toUpperCase())) {
      throw new Error(
        `Detector fixture environment cannot override harness variable ${key}.`,
      );
    }
    environment[key] = value;
  }

  return {
    ...environment,
    HOME: homeDirectory,
    npm_config_cache: cacheDirectory,
    PATH: createSystemPath(options.toolBinDirectory),
    TEMP: tempDirectory,
    TMP: tempDirectory,
    TMPDIR: tempDirectory,
    USERPROFILE: homeDirectory,
    XDG_CACHE_HOME: cacheDirectory,
  };
}
