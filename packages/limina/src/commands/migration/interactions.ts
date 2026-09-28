import path from 'pathe';
import {
  createDirtyWorkspaceDeclinedError,
  createDirtyWorkspacePrompt,
  inspectGitWorkspace,
} from './git';
import { confirmDirtyWorkspace, selectHardlinkStrategy } from './prompts';
import type { HardlinkMigrationDecision, RunMigrationOptions } from './types';

export type MigrationTask =
  | ReturnType<NonNullable<RunMigrationOptions['flow']>['start']>
  | undefined;

function resolveHardlinkStrategySelection(options: RunMigrationOptions) {
  return options.selectHardlinkStrategy ?? selectHardlinkStrategy;
}

function createHardlinkStrategyPrompt(
  rootDir: string,
  configPaths: readonly string[],
): string {
  const visiblePaths = configPaths.slice(0, 5);
  const remainingCount = configPaths.length - visiblePaths.length;
  const displayedPaths = visiblePaths.map(
    (configPath) => `  ${path.relative(rootDir, configPath)}`,
  );
  if (remainingCount > 0) {
    displayedPaths.push(`  ... and ${remainingCount} more`);
  }
  return [
    `Limina found ${configPaths.length} modified config files with multiple hard links:`,
    '',
    ...displayedPaths,
    '',
    'Replacing these files atomically would break their hard-link relationships.',
    '',
    'Rewriting them in place preserves the links, but all paths referencing the same files will observe the changes and these writes cannot provide atomic replacement guarantees.',
  ].join('\n');
}

async function requestMigrationDecision<Result>(options: {
  request: () => Promise<Result>;
  task: MigrationTask;
}): Promise<Result> {
  await options.task?.pause();
  try {
    return await options.request();
  } finally {
    options.task?.resume();
  }
}

export async function decideHardlinkPolicy(options: {
  configRootDir: string;
  hardlinkConfigPaths: readonly string[];
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): Promise<'rewrite' | 'skip'> {
  if (options.hardlinkConfigPaths.length === 0) return 'skip';
  const selectStrategy = resolveHardlinkStrategySelection(options.runOptions);
  const message = createHardlinkStrategyPrompt(
    options.configRootDir,
    options.hardlinkConfigPaths,
  );
  const decision = await requestMigrationDecision<HardlinkMigrationDecision>({
    request: () => selectStrategy(message),
    task: options.task,
  });
  if (decision === 'cancel') {
    throw new Error('limina migration canceled before writing config files.');
  }
  return decision;
}

function resolveDirtyWorkspaceConfirmation(options: RunMigrationOptions) {
  return options.confirmDirtyWorkspace ?? confirmDirtyWorkspace;
}

export async function confirmDirtyWorkspaceChanges(options: {
  roots: readonly string[];
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): Promise<void> {
  const workspaces = (
    await Promise.all(
      options.roots.map((rootDir) => inspectGitWorkspace(rootDir)),
    )
  ).filter((workspace) => workspace !== undefined);
  if (workspaces.length === 0) return;

  const confirm = resolveDirtyWorkspaceConfirmation(options.runOptions);
  const message = createDirtyWorkspacePrompt(workspaces);
  const accepted = await requestMigrationDecision({
    request: () => confirm(message),
    task: options.task,
  });
  if (accepted) return;

  throw createDirtyWorkspaceDeclinedError(workspaces);
}
