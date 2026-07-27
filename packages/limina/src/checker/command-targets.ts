import { toRelativePath } from '#utils/path';
import type {
  CheckerCommandTarget,
  CheckerCommandTargetOptions,
} from './types';

function getRelativeConfigPath(options: CheckerCommandTargetOptions): string {
  return toRelativePath(options.projectRootDir, options.configPath);
}

function getWatchArgs(watch: boolean | undefined): string[] {
  return watch === true ? ['--watch', '--preserveWatchOutput'] : [];
}

function getWatchLabel(watch: boolean | undefined): string {
  return watch === true ? ' --watch' : '';
}

function createBuildArgs(
  relativeConfigPath: string,
  watch: boolean | undefined,
): string[] {
  return [
    '-b',
    relativeConfigPath,
    '--pretty',
    'false',
    ...getWatchArgs(watch),
  ];
}

export function createTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: createBuildArgs(relativeConfigPath, options.watch),
    command: options.commandOverride ?? 'tsc',
    label: `tsc -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}

export function createTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: createBuildArgs(relativeConfigPath, options.watch),
    command: 'tsgo',
    label: `tsgo -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}

export function createVueTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: createBuildArgs(relativeConfigPath, options.watch),
    command: 'vue-tsc',
    label: `${options.checker.name}: vue-tsc -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}

export function createVueTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: ['--project', relativeConfigPath],
    command: 'vue-tsgo',
    label: `${options.checker.name}: vue-tsgo --project ${relativeConfigPath}`,
  };
}

export function createSvelteCheckCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: ['--tsconfig', relativeConfigPath],
    command: 'svelte-check',
    label: `${options.checker.name}: svelte-check --tsconfig ${relativeConfigPath}`,
  };
}
