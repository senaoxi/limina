import { execFileSync } from 'node:child_process';
import path from 'pathe';
import type { InputDependency } from './contracts';
import type { AnalysisInputs } from './inputs';
import { npmSetting, readInstallationText } from './installation-files';

export function pnpmBranchLocks(options: {
  root: string;
  settings: Record<string, unknown>;
  npmrc: string;
  inputs: AnalysisInputs;
  dependencies: InputDependency[];
}): string[] {
  if (!isBranchEnabled(options)) return ['pnpm-lock.yaml'];
  requireSimpleBinding(options.settings);
  const head = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'],
    { cwd: options.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const text = readInstallationText(head, options.inputs, options.dependencies);
  const branch = branchName(text);
  // pnpm 11's lockfileName adapter uses this exact branch spelling.
  const name = `pnpm-lock.${branch.replaceAll(/[^\w.-]/g, '!').toLowerCase()}.yaml`;
  return [path.basename(name), 'pnpm-lock.yaml'];
}

function isBranchEnabled(
  options: Parameters<typeof pnpmBranchLocks>[0],
): boolean {
  return (
    options.settings.gitBranchLockfile === true ||
    npmSetting(options.npmrc, 'git-branch-lockfile') === 'true'
  );
}
function requireSimpleBinding(settings: Record<string, unknown>): void {
  if (
    [
      settings.mergeGitBranchLockfiles,
      settings.mergeGitBranchLockfilesBranchPattern,
    ].some(Boolean)
  )
    throw new Error('Unproven merged branch-lock binding.');
}

function branchName(text: string | undefined): string {
  if (text === undefined || !text.startsWith('ref: refs/heads/'))
    throw new Error('Unproven detached branch-lock binding.');
  return text.slice('ref: refs/heads/'.length).trim();
}
