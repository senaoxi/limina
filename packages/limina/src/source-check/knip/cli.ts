import { normalizeAbsolutePath } from '#utils/path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import { LiminaOptionalToolMissingError } from '../../execution/tools';
import type { KnipCliInvocation, KnipCliRunner } from './types';

const requireFromLimina = createRequire(import.meta.url);

function ensureKnipCliPathExists(cliPath: string): string {
  if (!existsSync(cliPath)) {
    throw new Error(`Resolved Knip CLI path does not exist: ${cliPath}`);
  }
  return cliPath;
}

export function resolveKnipCliPath(
  resolvePackage: (
    specifier: string,
  ) => string = requireFromLimina.resolve.bind(requireFromLimina),
): string {
  try {
    const knipEntryPath = resolvePackage('knip');
    const cliPath = normalizeAbsolutePath(
      path.resolve(path.dirname(knipEntryPath), '../bin/knip.js'),
    );
    return ensureKnipCliPathExists(cliPath);
  } catch (error) {
    throw new LiminaOptionalToolMissingError({
      command: 'source check',
      error,
      packageName: 'knip',
      reason:
        'source.knip is enabled and Limina delegates unused source dependency and module detection to Knip.',
    });
  }
}

function appendOptionalArgument(
  args: string[],
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    args.push(name, value);
  }
}

function appendWorkspaceArguments(
  args: string[],
  workspaceNames: readonly string[] | undefined,
): void {
  if (workspaceNames === undefined) {
    return;
  }

  for (const workspaceName of workspaceNames) {
    args.push('--workspace', workspaceName);
  }
}

function createKnipArguments(options: KnipCliInvocation): string[] {
  const args = [
    resolveKnipCliPath(),
    '--directory',
    options.rootDir,
    '--config',
    options.configPath,
  ];
  for (const issueType of options.include) {
    args.push('--include', issueType);
  }
  appendOptionalArgument(args, '--tsConfig', options.tsConfigFile);
  appendWorkspaceArguments(args, options.workspaceNames);
  args.push(
    '--reporter',
    'json',
    '--no-exit-code',
    '--no-progress',
    '--no-config-hints',
  );
  return args;
}

function createKnipFailure(options: {
  args: readonly string[];
  error: Error;
  stderr: string;
}): Error {
  const lines = [
    'Knip source analysis failed.',
    '  reason: Limina delegates unused source dependency and module detection to Knip.',
    `  command: ${process.execPath} ${options.args.join(' ')}`,
  ];
  if (options.stderr.trim().length > 0) {
    lines.push(`  stderr:\n${options.stderr.trim()}`);
  }
  lines.push(`  error: ${options.error.message}`);
  return new Error(lines.join('\n'));
}

export const runKnipCli: KnipCliRunner = (
  options: KnipCliInvocation,
): Promise<string> => {
  const args = createKnipArguments(options);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: options.rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(createKnipFailure({ args, error, stderr }));
          return;
        }

        resolve(stdout);
      },
    );
  });
};
