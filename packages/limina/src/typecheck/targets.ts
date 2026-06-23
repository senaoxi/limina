import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
import { uniqueValues } from '#utils/collections';
import { prependPathEntry, shouldUseShellForCommand } from '#utils/process';

export interface TypecheckTarget {
  args: string[];
  checkerName?: string;
  configPath: string;
  cwd: string;
  command: string;
  executionKind?: CheckerExecutionKind;
  label?: string;
  sourceConfigPath?: string;
}

export interface TypecheckTargetResult {
  configPath: string;
  durationMs?: number;
  error?: Error;
  status: number;
}

export type TypecheckRunner = (
  target: TypecheckTarget,
) => Promise<TypecheckTargetResult> | TypecheckTargetResult;

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
  watch?: boolean;
}): TypecheckTarget {
  const adapter = getCheckerAdapter(options.checker.preset);

  if (!adapter) {
    throw new Error(
      `Checker "${options.checker.name}" uses unsupported preset "${options.checker.preset}".`,
    );
  }

  const commandTarget = adapter.createCommandTarget(options);

  return {
    ...commandTarget,
    checkerName: options.checker.name,
    configPath: options.configPath,
    cwd: options.projectRootDir,
    executionKind: options.executionKind,
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

function findNearestPackageDir(startDir: string): string | null {
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

function createVueTsgoCachePaths(configPath: string): string[] {
  const packageDir = findNearestPackageDir(path.dirname(configPath));

  if (!packageDir) {
    return [];
  }

  return uniqueValues([configPath, nodePath.resolve(configPath)]).map(
    (candidate) => {
      const configHash = createHash('sha256')
        .update(candidate)
        .digest('hex')
        .slice(0, 8);

      return path.join(packageDir, 'node_modules/.cache/vue-tsgo', configHash);
    },
  );
}

function collectVueTsgoConfigPaths(target: TypecheckTarget): string[] {
  const configPaths = new Set([target.configPath]);

  try {
    const route = collectGraphProjectRouteFromRoot({
      rootConfigPath: target.configPath,
      rootDir: target.cwd,
    });

    for (const projectPath of route.projectPaths) {
      configPaths.add(projectPath);
    }
  } catch {
    // Best effort cache cleanup must not mask the checker process result.
  }

  return [...configPaths];
}

function isVueTsgoCommand(command: string): boolean {
  const commandName = path.basename(command).toLowerCase();

  return commandName === 'vue-tsgo' || commandName === 'vue-tsgo.cmd';
}

/**
 * vue-tsgo generates a transient virtual TS workspace under
 * node_modules/.cache/vue-tsgo/<hash>. In project graphs where multiple
 * references converge on the same config, vue-tsgo can create duplicate
 * Project instances with the same targetRoot. Leaving a previous targetRoot
 * in place may race rm()/writeFile() during Project.generate() and fail with
 * ENOENT, so Limina clears reachable vue-tsgo workspaces before launching it.
 */
export async function prepareVueTsgoCache(
  target: TypecheckTarget,
): Promise<void> {
  if (!isVueTsgoCommand(target.command)) {
    return;
  }

  const cachePaths = collectVueTsgoConfigPaths(target).flatMap((configPath) =>
    createVueTsgoCachePaths(configPath),
  );

  await Promise.all(
    uniqueValues(cachePaths).map((cachePath) =>
      rm(cachePath, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      }),
    ),
  );
}

export function createDefaultRunner(
  options: { stdio?: CheckerProcessStdio } = {},
): TypecheckRunner {
  return async (target) => {
    await prepareVueTsgoCache(target);

    const processEnvironment = createCheckerProcessEnvironment(target);
    const stdio = options.stdio ?? 'inherit';

    return await new Promise<TypecheckTargetResult>((resolve) => {
      let settled = false;
      const finalize = (result: TypecheckTargetResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      const child = spawn(target.command, target.args, {
        cwd: target.cwd,
        env: processEnvironment,
        shell: shouldUseShellForCommand(target.command),
        stdio,
      });

      child.on('error', (error) => {
        finalize({
          configPath: target.configPath,
          error,
          status: 1,
        });
      });

      child.on('close', (code) => {
        finalize({
          configPath: target.configPath,
          status: code ?? 1,
        });
      });
    });
  };
}
