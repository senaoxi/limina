import { toRelativePath } from '#utils/path';
import { createRequire } from 'node:module';
import type {
  CheckerCommandTarget,
  CheckerCommandTargetOptions,
} from './types';

const requireFromLimina = createRequire(import.meta.url);

function getRelativeConfigPath(options: CheckerCommandTargetOptions): string {
  return toRelativePath(options.projectRootDir, options.configPath);
}

function getWatchArguments(watch: boolean | undefined): string[] {
  return watch === true ? ['--watch', '--preserveWatchOutput'] : [];
}

function getWatchLabel(watch: boolean | undefined): string {
  return watch === true ? ' --watch' : '';
}

function createBuildArguments(
  relativeConfigPath: string,
  watch: boolean | undefined,
): string[] {
  return [
    '-b',
    relativeConfigPath,
    '--pretty',
    'false',
    ...getWatchArguments(watch),
  ];
}

export function createTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  const arguments_ = createBuildArguments(relativeConfigPath, options.watch);
  return {
    args:
      options.commandOverride === undefined
        ? [requireFromLimina.resolve('typescript/bin/tsc'), ...arguments_]
        : arguments_,
    command: options.commandOverride ?? process.execPath,
    label: `tsc -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}

export function createTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: createBuildArguments(relativeConfigPath, options.watch),
    command: 'tsgo',
    label: `tsgo -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}

export function createVueTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = getRelativeConfigPath(options);
  return {
    args: createBuildArguments(relativeConfigPath, options.watch),
    command: 'vue-tsc',
    label: `${options.checker.name}: vue-tsc -b ${relativeConfigPath}${getWatchLabel(options.watch)}`,
  };
}
