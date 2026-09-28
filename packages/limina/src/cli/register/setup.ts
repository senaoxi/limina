import type { cac } from 'cac';
import { runInit } from '../../commands/init';
import { runMigration } from '../../commands/migration';
import { loadMigrationConfig } from '../command-runtime';
import { createCliFlow, runCliFlowWithCleanup } from '../flow';
import { parseConfigLoader } from '../parse';
import type { InitFlags, MigrationFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

async function runInitAction(flags: InitFlags): Promise<void> {
  await runInit({
    clearScreen: false,
    cwd: process.cwd(),
    yes: flags.yes,
  });
}

async function runMigrationAction(flags: MigrationFlags): Promise<void> {
  const flow = createCliFlow();
  const passed = await runCliFlowWithCleanup(
    flow,
    {
      failed: 'limina migration failed',
      passed: 'limina migration passed',
    },
    async () => {
      flow.intro('limina migration');
      const config = await loadMigrationConfig(flags);
      const result = await runMigration(config, {
        flow,
        flowDepth: 1,
        configLoader: parseConfigLoader(flags.configLoader),
        mode: flags.mode,
      });
      return result.inputConsumable && result.incompleteFiles.length === 0;
    },
  );
  if (!passed) process.exitCode = 1;
}

export function registerSetupCommands(cli: LiminaCli): void {
  cli
    .command('init', 'Initialize Limina files for a workspace')
    .option('--yes', 'Accept all init prompts')
    .action(runInitAction);
  cli
    .command('migration', 'Migrate TypeScript configs into Limina governance')
    .action(runMigrationAction);
}
