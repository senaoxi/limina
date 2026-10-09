import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import type { LiminaConfigLoader } from './root-types';
function tsxInstallation(): { root: string; version: string } | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('tsx/package.json');
    return {
      root: normalizeAbsolutePath(path.dirname(manifest)),
      version: require(manifest).version,
    };
  } catch {
    return undefined;
  }
}
function isKnownTsxEntry(argument: string, root: string): boolean {
  try {
    return normalizeAbsolutePath(
      realpathSync.native(startupLoaderPath(argument)),
    ).startsWith(`${root}/dist/`);
  } catch {
    return false;
  }
}
function startupLoaderPath(argument: string): string {
  return ['tsx', 'tsx/esm'].includes(argument)
    ? createRequire(path.join(process.cwd(), 'package.json')).resolve(argument)
    : loaderArgumentPath(argument);
}
function loaderArgumentPath(argument: string): string {
  return argument.startsWith('file:') ? fileURLToPath(argument) : argument;
}
function hasUnknownLoader(arguments_: string[], root: string): boolean {
  return arguments_.some((argument, index) =>
    isUnknownLoaderArgument(arguments_, { argument, index, root }),
  );
}
function isUnknownLoaderArgument(
  arguments_: string[],
  entry: { argument: string; index: number; root: string },
): boolean {
  if (['--loader', '--experimental-loader'].includes(entry.argument))
    return true;
  return ['--import', '--require', '-r'].includes(entry.argument)
    ? !isKnownTsxEntry(nextLoaderArgument(arguments_, entry.index), entry.root)
    : hasInlineUnknownLoader(entry.argument, entry.root);
}
function nextLoaderArgument(arguments_: string[], index: number): string {
  return arguments_[index + 1] ?? '';
}
function hasInlineUnknownLoader(argument: string, root: string): boolean {
  const flag = argument.slice(0, argument.indexOf('='));
  return [
    ['--loader', '--experimental-loader'].includes(flag),
    hasInlineImport(argument, root),
    hasInlineRequire(argument, root),
  ].some(Boolean);
}
function hasInlineRequire(argument: string, root: string): boolean {
  return [
    argument.startsWith('-r'),
    argument !== '-r',
    !isKnownTsxEntry(argument.slice(2), root),
  ].every(Boolean);
}
function hasInlineImport(argument: string, root: string): boolean {
  const separator = argument.indexOf('=');
  return (
    ['--import', '--require'].includes(argument.slice(0, separator)) &&
    !isKnownTsxEntry(argument.slice(separator + 1), root)
  );
}
function installationRoot(
  installation: ReturnType<typeof tsxInstallation>,
): string {
  return installation?.root ?? '';
}
function installationVersion(
  installation: ReturnType<typeof tsxInstallation>,
): string | null {
  return installation?.version ?? null;
}
function hasLoaderNodeOptions(): boolean {
  const options = process.env.NODE_OPTIONS ?? '';
  if (options.startsWith('-r')) return true;
  return [
    '--import',
    '--loader',
    '--experimental-loader',
    '--require',
    '-r ',
    ' -r',
    '"-r',
  ].some((flag) => options.includes(flag));
}
export function configLoaderIdentity(loader: LiminaConfigLoader): {
  identity: string;
  hasTransforms: boolean;
  unknownReasons: string[];
} {
  const installation = tsxInstallation();
  const isUnknown = hasUnknownLoader(
    process.execArgv,
    installationRoot(installation),
  );
  return {
    hasTransforms:
      loader === 'tsx' ||
      process.execArgv.some((argument) =>
        isKnownTsxEntry(argument, installationRoot(installation)),
      ),
    identity: JSON.stringify([
      'process-config-v2',
      loader,
      process.version,
      loaderRuntimeArguments(process.execArgv),
      installationVersion(installation),
    ]),
    unknownReasons: [isUnknown, hasLoaderNodeOptions()].some(Boolean)
      ? ['custom-loader-unobserved']
      : [],
  };
}
function loaderRuntimeArguments(arguments_: string[]): string[] {
  const modes = new Set(['--conditions', '-C', '--experimental-default-type']);
  const result: string[] = [];
  for (const [index, argument] of arguments_.entries())
    recordRuntimeArgument(result, { argument, index, arguments_, modes });
  return result;
}
function recordRuntimeArgument(
  result: string[],
  entry: {
    argument: string;
    index: number;
    arguments_: string[];
    modes: Set<string>;
  },
): void {
  const flag = entry.argument.split('=', 1)[0];
  if (entry.modes.has(flag)) {
    result.push(`${flag}=${runtimeArgumentValue(entry, flag)}`);
  } else recordRuntimeFlag(result, flag);
}
function runtimeArgumentValue(
  entry: { argument: string; index: number; arguments_: string[] },
  flag: string,
): string {
  const value = entry.argument.includes('=')
    ? entry.argument.slice(flag.length + 1)
    : entry.arguments_[entry.index + 1];
  return value ?? '';
}
function recordRuntimeFlag(result: string[], flag: string): void {
  const flags = new Set([
    '--import',
    '--require',
    '-r',
    '--loader',
    '--experimental-loader',
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--experimental-strip-types',
    '--no-experimental-strip-types',
    '--experimental-transform-types',
    '--experimental-require-module',
    '--no-experimental-require-module',
  ]);
  if (flags.has(flag)) result.push(flag);
}

/**
A preload can populate Node's resolver caches before observation starts. Cold
analysis cannot repair an already stale configuration evaluation.
*/
export function assertConfigLoaderStartup(loader: LiminaConfigLoader): void {
  if (configLoaderIdentity(loader).unknownReasons.length === 0) return;
  throw new Error(
    'Limina cannot safely load configuration with custom Node startup preloads or loaders. Start a new CLI process without --require, --import or --loader overrides; use --config-loader tsx for TypeScript transformation.',
  );
}
