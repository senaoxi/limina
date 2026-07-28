import type { PipelineStep } from '#config/runner';
import { prependPathEntry } from '#utils/process';
import path from 'pathe';
import {
  createCheckerTargetId,
  isVueTsgoCommand,
  type TypecheckTarget,
} from '../typecheck/targets';
import {
  VueTsgoCacheBatchCoordinator,
  type VueTsgoCacheCleanupDependencies,
} from '../typecheck/vue-tsgo-cache';

export type CommandPipelineStep = Extract<PipelineStep, { type: 'command' }>;

const configArgumentFlags = new Set(['--build', '-b', '--project', '-p']);

export function createCommandStepEnvironment(
  cwd: string,
  step: CommandPipelineStep,
): NodeJS.ProcessEnv {
  return prependPathEntry(
    { ...process.env, ...step.env },
    path.join(cwd, 'node_modules/.bin'),
  );
}

function getConfigPathAfterFlag(options: {
  args: readonly string[];
  index: number;
}): string | undefined {
  const configArg = options.args[options.index + 1];
  if (configArg === undefined) return undefined;
  return configArg.startsWith('-') ? undefined : configArg;
}

function getEqualsConfigPath(arg: string, cwd: string): string | undefined {
  if (!arg.startsWith('--project=')) return undefined;
  const configArg = arg.slice('--project='.length);
  if (configArg.length === 0) return undefined;
  return path.resolve(cwd, configArg);
}

function getSeparatedConfigPath(options: {
  arg: string;
  args: readonly string[];
  cwd: string;
  index: number;
}): string | undefined {
  if (!configArgumentFlags.has(options.arg)) return undefined;
  const configArg = getConfigPathAfterFlag(options);
  return configArg === undefined
    ? undefined
    : path.resolve(options.cwd, configArg);
}

function getExplicitConfigPath(options: {
  arg: string;
  args: readonly string[];
  cwd: string;
  index: number;
}): string | undefined {
  const equalsPath = getEqualsConfigPath(options.arg, options.cwd);
  if (equalsPath !== undefined) return equalsPath;
  return getSeparatedConfigPath(options);
}

function collectExplicitConfigPaths(
  args: readonly string[],
  cwd: string,
): string[] {
  return args
    .map((arg, index) => getExplicitConfigPath({ arg, args, cwd, index }))
    .filter((configPath) => configPath !== undefined);
}

function getStepArgs(step: CommandPipelineStep): readonly string[] {
  return step.args ?? [];
}

function withDefaultConfigPath(
  explicit: readonly string[],
  cwd: string,
): string[] {
  if (explicit.length > 0) return [...explicit];
  return [path.resolve(cwd, 'tsconfig.json')];
}

export function collectVueTsgoCommandConfigPaths(
  step: CommandPipelineStep,
  cwd: string,
): string[] {
  if (!isVueTsgoCommand(step.command)) return [];
  return withDefaultConfigPath(
    collectExplicitConfigPaths(getStepArgs(step), cwd),
    cwd,
  );
}

function createCommandCacheTarget(options: {
  configPath: string;
  cwd: string;
  step: CommandPipelineStep;
}): TypecheckTarget {
  return {
    args: [...(options.step.args ?? [])],
    command: options.step.command,
    configPath: options.configPath,
    cwd: options.cwd,
    id: createCheckerTargetId([
      'pipeline-vue-tsgo-cache',
      options.cwd,
      options.step.command,
      options.configPath,
    ]),
  };
}

export function createCommandCacheTargets(
  step: CommandPipelineStep,
  cwd: string,
): TypecheckTarget[] {
  return collectVueTsgoCommandConfigPaths(step, cwd).map((configPath) =>
    createCommandCacheTarget({ configPath, cwd, step }),
  );
}

export async function prepareCommandStepCache(
  step: CommandPipelineStep,
  cwd: string,
  cleanup?: VueTsgoCacheCleanupDependencies,
): Promise<{
  coordinator: VueTsgoCacheBatchCoordinator;
  targets: TypecheckTarget[];
} | null> {
  if (!isVueTsgoCommand(step.command)) return null;
  const targets = createCommandCacheTargets(step, cwd);
  return {
    coordinator: await VueTsgoCacheBatchCoordinator.prepare(targets, {
      ...(cleanup === undefined ? {} : { cleanup }),
      requireValidGeneratedRoute: false,
    }),
    targets,
  };
}

export async function prepareCommandCacheTargets(options: {
  cleanup?: VueTsgoCacheCleanupDependencies;
  cwd: string;
  step: CommandPipelineStep;
}): Promise<void> {
  const prepared = await prepareCommandStepCache(
    options.step,
    options.cwd,
    options.cleanup,
  );
  if (prepared === null) return;
  for (const target of prepared.targets) {
    await prepared.coordinator.beforeTargetRun(target);
  }
}
