import type { cac } from 'cac';
import { runInit } from '../../commands/init';
import type { InitFlags } from '../types';

async function runInitAction(flags: InitFlags): Promise<void> {
  await runInit({ clearScreen: false, cwd: process.cwd(), yes: flags.yes });
}

export function registerSetupCommands(cli: ReturnType<typeof cac>): void {
  cli
    .command('init', 'Initialize Limina files for a workspace')
    .option('--yes', 'Accept all init prompts')
    .action(runInitAction);
  cli
    .command(
      'migration',
      '[deprecated] Use limina-migrate to migrate TypeScript configs',
      { allowUnknownOptions: true },
    )
    .example('pnpm exec limina-migrate');
}
