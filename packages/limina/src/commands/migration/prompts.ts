import * as prompts from '@clack/prompts';
import type { HardlinkMigrationDecision } from './types';

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function isAccepted(result: boolean | symbol): result is true {
  if (prompts.isCancel(result)) return false;
  return result;
}

export async function confirmDirtyWorkspace(message: string): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    throw new Error(
      [
        'limina migration found changes in a Git working tree but cannot request confirmation in a non-interactive environment.',
        'Keep every involved Git working tree clean, then rerun npx limina migration.',
      ].join('\n'),
    );
  }

  const result = await prompts.confirm({
    initialValue: false,
    message,
  });
  return isAccepted(result);
}

export async function selectHardlinkStrategy(
  message: string,
): Promise<HardlinkMigrationDecision> {
  if (!isInteractiveTerminal()) {
    throw new Error(
      [
        'limina migration found modified config files with multiple hard links but cannot request a write strategy in a non-interactive environment.',
        'Run migration interactively and choose whether to skip or rewrite these files.',
      ].join('\n'),
    );
  }

  const result = await prompts.select<HardlinkMigrationDecision>({
    initialValue: 'rewrite',
    message,
    options: [
      {
        label: 'Rewrite hard-linked files in place',
        value: 'rewrite',
      },
      {
        label: 'Skip hard-linked files and migrate the rest',
        value: 'skip',
      },
      { label: 'Cancel migration', value: 'cancel' },
    ],
  });
  return prompts.isCancel(result) ? 'cancel' : result;
}
