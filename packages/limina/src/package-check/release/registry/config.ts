import { homedir } from 'node:os';
import path from 'pathe';
import { readReleaseRegistryTestAuthority } from '../../release-registry-test-seam';
import {
  createRegistryAuthority,
  type ReleaseRegistryConfig,
} from './authority';
import {
  readNpmEnvironment,
  readNpmrc,
  type RegistrySettings,
  resolveNpmConfigPath,
} from './npm-config-values';
import { resolveNpmProjectDirectory } from './npm-project';

const DEFAULT_REGISTRY = {
  value: 'https://registry.npmjs.org/',
  source: 'default',
};

function defaultPrefix(environment: NodeJS.ProcessEnv): string {
  if (environment.PREFIX !== undefined) return environment.PREFIX;
  const executableDirectory = path.dirname(process.execPath);
  return process.platform === 'win32'
    ? executableDirectory
    : path.dirname(executableDirectory);
}

function packageScope(packageName: string): string | undefined {
  return packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined;
}

function selectRegistry(settings: RegistrySettings, packageName: string) {
  const scope = packageScope(packageName);
  return (
    settings.get(`${scope}:registry`) ??
    settings.get('registry') ??
    DEFAULT_REGISTRY
  );
}

function readUserSettings(options: {
  cwd: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  settings: RegistrySettings;
}): RegistrySettings {
  const setting = options.settings.get('userconfig');
  const filePath = resolveNpmConfigPath({
    ...options,
    setting,
    fallback: path.join(options.home, '.npmrc'),
  });
  return readNpmrc({
    filePath,
    environment: options.environment,
    layer: 'user',
    required: setting !== undefined,
  });
}

function readGlobalSettings(options: {
  cwd: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  settings: RegistrySettings;
}): RegistrySettings {
  const prefix = resolveNpmConfigPath({
    ...options,
    setting: options.settings.get('prefix'),
    fallback: defaultPrefix(options.environment),
  });
  const setting = options.settings.get('globalconfig');
  const filePath = resolveNpmConfigPath({
    ...options,
    setting,
    fallback: path.join(prefix, 'etc', 'npmrc'),
  });
  return readNpmrc({
    filePath,
    environment: options.environment,
    layer: 'global',
    required: setting !== undefined,
  });
}

function readSettings(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): RegistrySettings {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const environment_ = readNpmEnvironment(environment);
  const project = readNpmrc({
    filePath: path.join(resolveNpmProjectDirectory(cwd), '.npmrc'),
    environment,
    layer: 'project',
    required: false,
  });
  const user = readUserSettings({
    cwd,
    environment,
    home,
    settings: new Map([...project, ...environment_]),
  });
  const global = readGlobalSettings({
    cwd,
    environment,
    home,
    settings: new Map([...user, ...project, ...environment_]),
  });
  return new Map([...global, ...user, ...project, ...environment_]);
}

export function loadReleaseRegistryConfig(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseRegistryConfig {
  const snapshot = { ...environment };
  const testAuthority = readReleaseRegistryTestAuthority(snapshot);
  if (testAuthority !== undefined)
    return Object.freeze({ authorityFor: () => testAuthority });
  const settings = readSettings(path.resolve(cwd), snapshot);
  return Object.freeze({
    authorityFor(packageName: string) {
      const selected = selectRegistry(settings, packageName);
      return createRegistryAuthority({ ...selected, kind: 'production' });
    },
  });
}
