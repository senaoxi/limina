import { normalizeAbsolutePath } from '#utils/path';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'pathe';
import { formatErrorMessage } from '../../logger';
import type { MigrationTarget } from './types';

interface GitCommandResult {
  stderr: string;
  stdout: string;
}

function appendNonEmptyDetail(
  lines: string[],
  label: string,
  value: string,
): void {
  if (value.trim().length > 0) {
    lines.push(`${label}: ${value.trim()}`);
  }
}

function createGitCommandError(
  title: string,
  stderr: string,
  error: Error,
): Error {
  const lines = [title];
  appendNonEmptyDetail(lines, 'stderr', stderr);
  appendNonEmptyDetail(lines, 'reason', error.message);
  return new Error(lines.join('\n'), { cause: error });
}

function runGitCommand(options: {
  args: readonly string[];
  cwd: string;
  failureTitle: string;
}): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...options.args],
      { cwd: options.cwd, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(createGitCommandError(options.failureTitle, stderr, error));
          return;
        }
        resolve({ stderr, stdout });
      },
    );
  });
}

async function findGitWorktreeRoot(targetPath: string): Promise<string> {
  const result = await runGitCommand({
    args: ['rev-parse', '--show-toplevel'],
    cwd: path.dirname(targetPath),
    failureTitle: [
      `Unable to resolve the Git worktree for ${targetPath}.`,
      'fix: every migration target must belong to a Git worktree.',
    ].join('\n'),
  });
  return normalizeAbsolutePath(result.stdout.trim());
}

export async function collectMigrationWorktreeRoots(
  targets: readonly MigrationTarget[],
): Promise<string[]> {
  const rootsByCanonicalIdentity = new Map<string, string>();

  for (const target of targets) {
    const rootDir = await findGitWorktreeRoot(target.configPath);
    rootsByCanonicalIdentity.set(
      normalizeAbsolutePath(await realpath(rootDir)),
      rootDir,
    );
  }

  return [...rootsByCanonicalIdentity.values()].sort((left, right) =>
    left.localeCompare(right),
  );
}

function getStatusLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function createDirtyWorkspaceError(statusLines: readonly string[]): Error {
  const overflow = statusLines.length - 20;
  return new Error(
    [
      'limina migration requires a clean git working tree before editing tsconfig files.',
      'Commit, stash, or discard these changes, then rerun npx limina migration.',
      'git status:',
      ...statusLines.slice(0, 20).map((line) => `  ${line}`),
      ...(overflow > 0 ? [`  ... and ${overflow} more`] : []),
    ].join('\n'),
  );
}

export async function assertCleanGitWorkspace(rootDir: string): Promise<void> {
  let result: GitCommandResult;

  try {
    result = await runGitCommand({
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      cwd: rootDir,
      failureTitle: 'git status --porcelain=v1 --untracked-files=all failed.',
    });
  } catch (error) {
    throw new Error(
      [
        'Unable to verify the git working tree before running limina migration.',
        `  root: ${rootDir}`,
        `  reason: ${formatErrorMessage(error)}`,
        '  fix: run limina migration inside a git repository with a clean working tree.',
      ].join('\n'),
      { cause: error },
    );
  }

  const statusLines = getStatusLines(result.stdout);
  if (statusLines.length > 0) {
    throw createDirtyWorkspaceError(statusLines);
  }
}
