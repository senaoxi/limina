import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import path from 'pathe';

import {
  type CheckerPackageResolver,
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
  getCheckerAdapter,
} from '#checkers';
import type {
  CheckerExecutionKind,
  ImportAnalysisConfig,
  ResolvedCheckerConfig,
} from '#config/runner';
import { collectGraphProjectRouteFromRoot } from '#core/tsconfig/actions';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import { prependPathEntry, shouldUseShellForCommand } from '#utils/process';
import { runCheckerSpawnMeasured } from './process-host';

declare const checkerTargetIdBrand: unique symbol;
export type CheckerTargetId = string & {
  readonly [checkerTargetIdBrand]: 'CheckerTargetId';
};

export function checkerTargetId(value: string): CheckerTargetId {
  if (!/^checker-target:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Invalid checker target id: ${value}.`);
  }
  return value as CheckerTargetId;
}

export function createCheckerTargetId(
  identity: readonly string[],
): CheckerTargetId {
  return checkerTargetId(
    `checker-target:${createHash('sha256').update(identity.join('\0')).digest('hex')}`,
  );
}

export interface TypecheckTarget {
  args: string[];
  checkerName?: string;
  configPath: string;
  cwd: string;
  command: string;
  executionKind?: CheckerExecutionKind;
  id: CheckerTargetId;
  label?: string;
  sourceConfigPath?: string;
}

export interface TypecheckTargetResult {
  blockedBy?: readonly CheckerTargetId[];
  configPath: string;
  durationMs: number;
  error?: Error;
  id: CheckerTargetId;
  status: number;
}

export type TypecheckRunnerResult = Omit<
  TypecheckTargetResult,
  'durationMs' | 'id'
> &
  Partial<Pick<TypecheckTargetResult, 'durationMs' | 'id'>>;

export type CheckerTargetOutcome =
  | {
      durationMs: number;
      id: CheckerTargetId;
      status: 'passed';
    }
  | {
      durationMs: number;
      error?: Error;
      exitCode: number;
      id: CheckerTargetId;
      status: 'failed';
    }
  | {
      blockedBy: readonly CheckerTargetId[];
      id: CheckerTargetId;
      status: 'blocked';
    };

export function toCheckerTargetOutcome(
  target: TypecheckTarget,
  result: TypecheckTargetResult,
): CheckerTargetOutcome {
  if (result.id !== target.id) {
    throw new Error(
      `Checker target result identity mismatch for ${target.id}.`,
    );
  }
  if (result.blockedBy) {
    return { blockedBy: result.blockedBy, id: result.id, status: 'blocked' };
  }

  const durationMs = result.durationMs;
  return result.status === 0
    ? { durationMs, id: result.id, status: 'passed' }
    : {
        durationMs,
        error: result.error,
        exitCode: result.status,
        id: result.id,
        status: 'failed',
      };
}

export type TypecheckRunner = (
  target: TypecheckTarget,
) => Promise<TypecheckRunnerResult> | TypecheckRunnerResult;

type CheckerProcessStdio = 'ignore' | 'inherit';

export function getExecutionCheckers(options: {
  checkers: ResolvedCheckerConfig[];
  executionKind: CheckerExecutionKind;
}): ResolvedCheckerConfig[] {
  return options.checkers.filter((checker) => {
    const adapter = getCheckerAdapter(checker.preset);

    return adapter?.execution === options.executionKind;
  });
}

function resolvePackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromRoot = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );

  try {
    return requireFromRoot.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      return options.packageName;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }

    throw error;
  }
}

export function collectCheckerPeerDependencyProblems(options: {
  checkers: ResolvedCheckerConfig[];
  imports?: ImportAnalysisConfig;
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): string[] {
  const resolvePackage = options.resolvePackage ?? resolvePackageFromRoot;
  const missingDependencies = collectMissingCheckerPeerDependencies({
    checkers: options.checkers,
    projectRootDir: options.projectRootDir,
    resolvePackage,
  });
  const vueCompilerSfcCheckers = options.checkers.filter(
    (checker) =>
      options.imports?.vue === 'compiler-sfc' &&
      (checker.preset === 'vue-tsc' || checker.preset === 'vue-tsgo'),
  );

  if (
    vueCompilerSfcCheckers.length > 0 &&
    !resolvePackage({
      packageName: '@vue/compiler-sfc',
      projectRootDir: options.projectRootDir,
    })
  ) {
    missingDependencies.push({
      checkerNames: vueCompilerSfcCheckers
        .map((checker) => checker.name)
        .sort((left, right) => left.localeCompare(right)),
      packageName: '@vue/compiler-sfc',
      reason: 'enabled by config.imports.vue: "compiler-sfc"',
    });
  }

  return missingDependencies.length === 0
    ? []
    : [formatMissingCheckerPeerDependencies(missingDependencies)];
}

export function createCheckerTarget(options: {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
  sourceConfigPath?: string;
  watch?: boolean;
}): TypecheckTarget {
  const adapter = getCheckerAdapter(options.checker.preset);

  if (!adapter) {
    throw new Error(
      `Checker "${options.checker.name}" uses unsupported preset "${options.checker.preset}".`,
    );
  }

  const commandTarget = adapter.createCommandTarget(options);

  const sourceConfigPath = options.sourceConfigPath ?? options.configPath;
  const portableSourceConfigPath = normalizeSlashes(
    toRelativePath(options.projectRootDir, sourceConfigPath),
  );
  const portableConfigPath = normalizeSlashes(
    toRelativePath(options.projectRootDir, options.configPath),
  );

  return {
    ...commandTarget,
    checkerName: options.checker.name,
    configPath: options.configPath,
    cwd: options.projectRootDir,
    executionKind: options.executionKind,
    id: createCheckerTargetId([
      'checker-target',
      options.executionKind,
      options.checker.name,
      portableSourceConfigPath,
      portableConfigPath,
    ]),
    sourceConfigPath,
  };
}

function createCheckerProcessEnvironment(
  target: TypecheckTarget,
): NodeJS.ProcessEnv {
  return prependPathEntry(
    process.env,
    path.join(target.cwd, 'node_modules/.bin'),
  );
}

export function findNearestPackageDir(startDir: string): string | null {
  let currentDir = startDir;

  for (;;) {
    if (existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function createVueTsgoCachePaths(configPath: string): string[] {
  const packageDir = findNearestPackageDir(path.dirname(configPath));

  if (!packageDir) {
    return [];
  }

  // vue-tsgo derives its cache directory from the OS-native absolute config
  // path (`node:path.resolve(cwd, --project)`), so hash that exact form. Using
  // `nodePath.resolve` also canonicalizes the slash style, keeping the hash
  // stable whether the incoming path arrives in pathe (forward-slash) or native
  // (Windows backslash) form — one logical config maps to one cache path on
  // every platform.
  const configHash = createHash('sha256')
    .update(nodePath.resolve(configPath))
    .digest('hex')
    .slice(0, 8);

  return [path.join(packageDir, 'node_modules/.cache/vue-tsgo', configHash)];
}

export function collectVueTsgoConfigPaths(
  target: Pick<TypecheckTarget, 'configPath' | 'cwd'>,
  options: { requireValidGeneratedRoute?: boolean } = {},
): string[] {
  const configPaths = new Set([target.configPath]);

  const route = collectGraphProjectRouteFromRoot({
    rootConfigPath: target.configPath,
    rootDir: target.cwd,
  });
  if (options.requireValidGeneratedRoute && route.problems.length > 0) {
    throw new Error(
      ['Unable to prove vue-tsgo cache routes:', ...route.problems].join('\n'),
    );
  }
  for (const projectPath of route.projectPaths) {
    configPaths.add(projectPath);
  }

  return [...configPaths];
}

export function isVueTsgoCommand(command: string): boolean {
  const commandName = path.basename(command).toLowerCase();

  return commandName === 'vue-tsgo' || commandName === 'vue-tsgo.cmd';
}

export function createDefaultRunner(
  options: {
    onDegraded?: (reason: string) => void;
    stdio?: CheckerProcessStdio;
  } = {},
): TypecheckRunner {
  return async (target) => {
    const measurement = await runCheckerSpawnMeasured(
      {
        args: target.args,
        command: target.command,
        cwd: target.cwd,
        env: createCheckerProcessEnvironment(target),
        shell: shouldUseShellForCommand(target.command),
        stdio: options.stdio ?? 'inherit',
      },
      { onDegraded: options.onDegraded },
    );

    return {
      configPath: target.configPath,
      durationMs: measurement.durationMs,
      ...(measurement.error ? { error: measurement.error } : {}),
      status: measurement.status,
    };
  };
}

/**
 * Wraps one runner invocation so its result always carries a duration. A
 * runner-reported duration wins because it can be measured next to the
 * checker process; the wall-clock fallback only covers custom runners and is
 * inflated by event-loop delay whenever the parent thread is blocked.
 */
export async function runTargetWithMeasuredDuration(
  runner: TypecheckRunner,
  target: TypecheckTarget,
): Promise<TypecheckTargetResult> {
  const startedAt = performance.now();
  const result = await runner(target);

  return {
    ...result,
    id: target.id,
    durationMs: result.durationMs ?? performance.now() - startedAt,
  };
}
