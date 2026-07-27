import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import path from 'pathe';

import { collectGraphProjectRouteFromRoot } from '#core/tsconfig/actions';
import type { TypecheckTarget } from './target-types';

export function findNearestPackageDir(startDir: string): string | null {
  if (existsSync(path.join(startDir, 'package.json'))) {
    return startDir;
  }

  const parentDir = path.dirname(startDir);
  return parentDir === startDir ? null : findNearestPackageDir(parentDir);
}

function createVueTsgoCacheHash(configPath: string): string {
  return createHash('sha256')
    .update(nodePath.resolve(configPath))
    .digest('hex')
    .slice(0, 8);
}

export function createVueTsgoCachePaths(configPath: string): string[] {
  const packageDir = findNearestPackageDir(path.dirname(configPath));

  if (packageDir === null) {
    return [];
  }

  return [
    path.join(
      packageDir,
      'node_modules/.cache/vue-tsgo',
      createVueTsgoCacheHash(configPath),
    ),
  ];
}

function assertValidGeneratedRoute(options: {
  problems: readonly string[];
  required: boolean;
}): void {
  if (!options.required || options.problems.length === 0) {
    return;
  }

  throw new Error(
    ['Unable to prove vue-tsgo cache routes:', ...options.problems].join('\n'),
  );
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

  assertValidGeneratedRoute({
    problems: route.problems,
    required: options.requireValidGeneratedRoute === true,
  });

  for (const projectPath of route.projectPaths) {
    configPaths.add(projectPath);
  }

  return [...configPaths];
}

export function isVueTsgoCommand(command: string): boolean {
  const commandName = path.basename(command).toLowerCase();
  return commandName === 'vue-tsgo' || commandName === 'vue-tsgo.cmd';
}
