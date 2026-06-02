import { createElapsedTimer } from 'logaria/helper';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'pathe';
import {
  type CheckerPackageResolver,
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
  getCheckerAdapter,
} from '../checkers';
import {
  type CheckerExecutionKind,
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '../config';
import type { LiminaFlowReporter, LiminaFlowTask } from '../flow';
import { clearCliScreen, formatErrorMessage, TypecheckLogger } from '../logger';
import {
  collectGraphProjectRouteFromRoot,
  resolveProjectConfigPath,
} from '../tsconfig';
import { normalizeAbsolutePath, toRelativePath } from '../utils/path';

export interface TypecheckTarget {
  args: string[];
  checkerName?: string;
  configPath: string;
  cwd: string;
  command: string;
  executionKind?: CheckerExecutionKind;
  label?: string;
}

export interface TypecheckTargetResult {
  configPath: string;
  error?: Error;
  status: number;
}

export type TypecheckRunner = (
  target: TypecheckTarget,
) => Promise<TypecheckTargetResult> | TypecheckTargetResult;

function getExecutionCheckers(options: {
  checkers: ResolvedCheckerConfig[];
  executionKind: CheckerExecutionKind;
}): ResolvedCheckerConfig[] {
  return options.checkers.filter((checker) => {
    const adapter = getCheckerAdapter(checker.preset);

    return adapter?.execution === options.executionKind;
  });
}

function collectCheckerPeerDependencyProblems(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): string[] {
  const missingDependencies = collectMissingCheckerPeerDependencies({
    checkers: options.checkers,
    projectRootDir: options.projectRootDir,
    resolvePackage: options.resolvePackage,
  });

  return missingDependencies.length === 0
    ? []
    : [formatMissingCheckerPeerDependencies(missingDependencies)];
}

function createCheckerTarget(options: {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
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
  return {
    ...process.env,
    PATH: [path.join(target.cwd, 'node_modules/.bin'), process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
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

function createVueTsgoCachePath(configPath: string): string | null {
  const packageDir = findNearestPackageDir(path.dirname(configPath));

  if (!packageDir) {
    return null;
  }

  const configHash = createHash('sha256')
    .update(configPath)
    .digest('hex')
    .slice(0, 8);

  return path.join(packageDir, 'node_modules/.cache/vue-tsgo', configHash);
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

  const cachePaths = collectVueTsgoConfigPaths(target)
    .map((configPath) => createVueTsgoCachePath(configPath))
    .filter((cachePath): cachePath is string => Boolean(cachePath));

  await Promise.all(
    [...new Set(cachePaths)].map((cachePath) =>
      rm(cachePath, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      }),
    ),
  );
}

function createDefaultRunner(): TypecheckRunner {
  return async (target) => {
    await prepareVueTsgoCache(target);

    const processEnvironment = createCheckerProcessEnvironment(target);

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
        shell: process.platform === 'win32',
        stdio: 'inherit',
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

async function runWithConcurrency(
  targets: TypecheckTarget[],
  concurrency: number,
  runner: TypecheckRunner,
  options: {
    onTargetResult?: (
      target: TypecheckTarget,
      result: TypecheckTargetResult,
    ) => void;
    onTargetStart?: (target: TypecheckTarget) => void;
  } = {},
): Promise<TypecheckTargetResult[]> {
  const results: TypecheckTargetResult[] = [];
  let nextIndex = 0;

  await Promise.all(
    Array.from({
      length: Math.min(concurrency, targets.length),
    }).map(async () => {
      for (;;) {
        const targetIndex = nextIndex;
        nextIndex += 1;

        if (targetIndex >= targets.length) {
          return;
        }

        try {
          const target = targets[targetIndex];

          options.onTargetStart?.(target);
          results[targetIndex] = await runner(target);
          options.onTargetResult?.(target, results[targetIndex]);
        } catch (error) {
          const target = targets[targetIndex];

          results[targetIndex] = {
            configPath: target.configPath,
            error: error instanceof Error ? error : new Error(String(error)),
            status: 1,
          };
          options.onTargetResult?.(target, results[targetIndex]);
        }
      }
    }),
  );

  return results;
}

export interface RunCheckerBuildOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
}

export interface RunCheckerBuildResult {
  passed: boolean;
  projectRootDir: string;
  rootConfigPaths: string[];
}

export interface RunCheckerTypecheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
}

export interface RunCheckerTypecheckResult {
  passed: boolean;
  projectRootDir: string;
  rootConfigPaths: string[];
}

async function runCheckerBuildInternal(
  options: RunCheckerBuildOptions,
): Promise<RunCheckerBuildResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const allCheckers = getActiveCheckers(options.config);
  const checkers = getExecutionCheckers({
    checkers: allCheckers,
    executionKind: 'build',
  });
  const flowDepth = options.flowDepth ?? 0;
  const rootConfigPaths: string[] = [];
  const problems = collectCheckerPeerDependencyProblems({
    checkers: allCheckers,
    projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });

  if (problems.length > 0) {
    options.flow?.fail('checker dependency preflight failed', {
      depth: flowDepth + 1,
    });
    TypecheckLogger.error(problems.join('\n\n'));

    return {
      passed: false,
      projectRootDir,
      rootConfigPaths,
    };
  }

  const targets = checkers.flatMap((checker) => {
    const configPath = resolveProjectConfigPath(projectRootDir, checker.entry);

    rootConfigPaths.push(configPath);

    return [
      createCheckerTarget({
        checker,
        commandOverride: options.tscCommand,
        configPath,
        executionKind: 'build',
        projectRootDir,
      }),
    ];
  });

  options.flow?.info(`found ${targets.length} checker build entry(s)`, {
    depth: flowDepth + 1,
  });

  TypecheckLogger.info(
    [
      `Running build checks for ${targets.length} checker entry(s).`,
      `CWD: ${toRelativePath(cwd, projectRootDir)}`,
      `Entries: ${rootConfigPaths
        .map((configPath) => toRelativePath(projectRootDir, configPath))
        .join(', ')}`,
    ].join('\n'),
  );

  const targetTasks = new Map<string, LiminaFlowTask>();
  const results = await runWithConcurrency(
    targets,
    1,
    options.runner ?? createDefaultRunner(),
    {
      onTargetResult: (target, result) => {
        const task = targetTasks.get(target.configPath);

        if (!task) {
          return;
        }

        if (result.status === 0) {
          task.pass();
        } else {
          const suffix = result.error
            ? formatErrorMessage(result.error)
            : `exited with code ${result.status}`;

          task.fail(undefined, { error: suffix });
        }
      },
      onTargetStart: (target) => {
        if (!options.flow) {
          return;
        }

        targetTasks.set(
          target.configPath,
          options.flow.start(
            target.label ??
              `checker build: ${toRelativePath(projectRootDir, target.configPath)}`,
            {
              collapseOnSuccess: false,
              depth: flowDepth + 1,
            },
          ),
        );
      },
    },
  );
  const failedResults = results.filter((result) => result.status !== 0);
  const passed = failedResults.length === 0;

  if (!passed) {
    TypecheckLogger.error(
      [
        'build checks failed:',
        ...failedResults.map((result) => {
          const suffix = result.error
            ? `: ${formatErrorMessage(result.error)}`
            : ` exited with code ${result.status}`;

          return `  ${toRelativePath(projectRootDir, result.configPath)}${suffix}`;
        }),
      ].join('\n'),
    );
  } else if (!options.flow?.interactive) {
    TypecheckLogger.success(
      `Checked ${targets.length} checker build entry(s).`,
    );
  }

  return {
    passed,
    projectRootDir,
    rootConfigPaths,
  };
}

export async function runCheckerBuild(
  options: RunCheckerBuildOptions,
): Promise<RunCheckerBuildResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('checker build', {
    depth: options.flowDepth ?? 0,
  });

  TypecheckLogger.info('checker build started');

  try {
    const result = await runCheckerBuildInternal(options);

    if (result.passed) {
      if (!options.flow?.interactive) {
        TypecheckLogger.success('checker build finished', elapsed());
      }

      task?.pass();
    } else {
      TypecheckLogger.error('checker build finished with failures', elapsed());
      task?.fail('checker build finished with failures');
    }
    return result;
  } catch (error) {
    TypecheckLogger.error(
      `checker build failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('checker build failed', { error });
    throw error;
  }
}

async function runCheckerTypecheckInternal(
  options: RunCheckerTypecheckOptions,
): Promise<RunCheckerTypecheckResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const allCheckers = getActiveCheckers(options.config);
  const checkers = getExecutionCheckers({
    checkers: allCheckers,
    executionKind: 'typecheck',
  });
  const flowDepth = options.flowDepth ?? 0;
  const rootConfigPaths: string[] = [];
  const problems = collectCheckerPeerDependencyProblems({
    checkers: allCheckers,
    projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });

  if (problems.length > 0) {
    options.flow?.fail('checker dependency preflight failed', {
      depth: flowDepth + 1,
    });
    TypecheckLogger.error(problems.join('\n\n'));

    return {
      passed: false,
      projectRootDir,
      rootConfigPaths,
    };
  }

  const targets = checkers.map((checker) => {
    const configPath = resolveProjectConfigPath(projectRootDir, checker.entry);

    rootConfigPaths.push(configPath);

    return createCheckerTarget({
      checker,
      commandOverride: options.tscCommand,
      configPath,
      executionKind: 'typecheck',
      projectRootDir,
    });
  });

  if (targets.length === 0) {
    options.flow?.info('no second-class checker entries configured', {
      depth: flowDepth + 1,
    });

    if (!options.flow?.interactive) {
      TypecheckLogger.success('No second-class checker entries configured.');
    }

    return {
      passed: true,
      projectRootDir,
      rootConfigPaths,
    };
  }

  options.flow?.info(`found ${targets.length} checker typecheck entry(s)`, {
    depth: flowDepth + 1,
  });

  TypecheckLogger.info(
    [
      `Running typecheck for ${targets.length} checker entry(s).`,
      `CWD: ${toRelativePath(cwd, projectRootDir)}`,
      `Entries: ${rootConfigPaths
        .map((configPath) => toRelativePath(projectRootDir, configPath))
        .join(', ')}`,
    ].join('\n'),
  );

  const targetTasks = new Map<string, LiminaFlowTask>();
  const results = await runWithConcurrency(
    targets,
    1,
    options.runner ?? createDefaultRunner(),
    {
      onTargetResult: (target, result) => {
        const task = targetTasks.get(target.configPath);

        if (!task) {
          return;
        }

        if (result.status === 0) {
          task.pass();
        } else {
          const suffix = result.error
            ? formatErrorMessage(result.error)
            : `exited with code ${result.status}`;

          task.fail(undefined, { error: suffix });
        }
      },
      onTargetStart: (target) => {
        if (!options.flow) {
          return;
        }

        targetTasks.set(
          target.configPath,
          options.flow.start(
            target.label ??
              `checker typecheck: ${toRelativePath(projectRootDir, target.configPath)}`,
            {
              collapseOnSuccess: false,
              depth: flowDepth + 1,
            },
          ),
        );
      },
    },
  );
  const failedResults = results.filter((result) => result.status !== 0);
  const passed = failedResults.length === 0;

  if (!passed) {
    TypecheckLogger.error(
      [
        'typecheck checks failed:',
        ...failedResults.map((result) => {
          const suffix = result.error
            ? `: ${formatErrorMessage(result.error)}`
            : ` exited with code ${result.status}`;

          return `  ${toRelativePath(projectRootDir, result.configPath)}${suffix}`;
        }),
      ].join('\n'),
    );
  } else if (!options.flow?.interactive) {
    TypecheckLogger.success(
      `Checked ${targets.length} checker typecheck entry(s).`,
    );
  }

  return {
    passed,
    projectRootDir,
    rootConfigPaths,
  };
}

export async function runCheckerTypecheck(
  options: RunCheckerTypecheckOptions,
): Promise<RunCheckerTypecheckResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('checker typecheck', {
    depth: options.flowDepth ?? 0,
  });

  TypecheckLogger.info('checker typecheck started');

  try {
    const result = await runCheckerTypecheckInternal(options);

    if (result.passed) {
      if (!options.flow?.interactive) {
        TypecheckLogger.success('checker typecheck finished', elapsed());
      }

      task?.pass();
    } else {
      TypecheckLogger.error(
        'checker typecheck finished with failures',
        elapsed(),
      );
      task?.fail('checker typecheck finished with failures');
    }

    return result;
  } catch (error) {
    TypecheckLogger.error(
      `checker typecheck failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('checker typecheck failed', { error });
    throw error;
  }
}
