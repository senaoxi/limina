import { execFile } from 'node:child_process';
import { formatErrorMessage, InitLogger } from '../../logger';
import { promptOptionalAction } from './prompts';
import { formatCommand, liminaSkillInstallCommand } from './shared';
import type { InitSkillInstallResult } from './types';

function runCommand(
  command: readonly [string, ...string[]],
  cwd: string,
): Promise<void> {
  const [bin, ...args] = command;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd }, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createSkippedResult(reason: string): InitSkillInstallResult {
  const command = formatCommand(liminaSkillInstallCommand);
  InitLogger.info(`skill install skipped; run ${command} to install it.`);
  return {
    flowStatus: 'skip',
    message: `limina skill (skipped: ${reason}; run ${command})`,
    status: 'skipped',
  };
}

function getPromptSkipReason(
  result: 'accepted' | 'rejected' | 'unavailable',
): string | null {
  if (result === 'accepted') {
    return null;
  }

  return result === 'unavailable' ? 'non-interactive' : 'declined';
}

async function resolveSkillInstallDecision(
  yes: boolean | undefined,
): Promise<InitSkillInstallResult | null> {
  if (yes === true) {
    return createSkippedResult('--yes');
  }

  const promptResult = await promptOptionalAction(
    'Install the Limina agent skill for this project?',
  );
  const skipReason = getPromptSkipReason(promptResult);
  return skipReason === null ? null : createSkippedResult(skipReason);
}

async function executeSkillInstall(
  rootDir: string,
): Promise<InitSkillInstallResult> {
  const command = formatCommand(liminaSkillInstallCommand);
  try {
    await runCommand(liminaSkillInstallCommand, rootDir);
    InitLogger.success('limina skill installed.');
    return {
      flowStatus: 'pass',
      message: 'limina skill installed',
      status: 'installed',
    };
  } catch (error) {
    InitLogger.warn(
      [
        `limina skill install failed: ${formatErrorMessage(error)}`,
        `retry: ${command}`,
      ].join('\n'),
    );
    return {
      flowStatus: 'skip',
      message: `limina skill (skipped: install failed; retry: ${command})`,
      status: 'failed',
    };
  }
}

export async function installLiminaSkill(options: {
  rootDir: string;
  yes?: boolean;
}): Promise<InitSkillInstallResult> {
  const decision = await resolveSkillInstallDecision(options.yes);
  return decision ?? executeSkillInstall(options.rootDir);
}
