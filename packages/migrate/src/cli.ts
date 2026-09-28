#!/usr/bin/env node
import { cac } from 'cac';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { assertRuntimeVersion } from './runtime-version';

interface MigrationFlags {
  config?: string;
  configLoader?: string;
  mode?: string;
}

async function runMigrationAction(flags: MigrationFlags): Promise<void> {
  assertRuntimeVersion();
  const {
    clearCliScreen,
    createCliFlow,
    loadConfig,
    parseConfigLoader,
    runCliFlowWithCleanup,
  } = await import('limina/internal/migration');
  const { runMigration } = await import('./migration');
  clearCliScreen();
  const flow = createCliFlow();
  const passed = await runCliFlowWithCleanup(
    flow,
    { failed: 'limina-migrate failed', passed: 'limina-migrate passed' },
    async () => {
      flow.intro('limina-migrate');
      const configLoader = parseConfigLoader(flags.configLoader);
      const config = await loadConfig({
        command: 'migration',
        configLoader,
        configPath: flags.config,
        cwd: process.cwd(),
        mode: flags.mode,
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes('unable to find limina config')
        ) {
          throw new Error(
            'Run npx limina init first, then rerun npx limina-migrate.',
            { cause: error },
          );
        }
        throw error;
      });
      const result = await runMigration(config, {
        flow,
        flowDepth: 1,
        configLoader,
        mode: flags.mode,
      });
      return result.inputConsumable && result.incompleteFiles.length === 0;
    },
  );
  if (!passed) process.exitCode = 1;
}

export function createMigrationCli(): ReturnType<typeof cac> {
  const cli = cac('limina-migrate');
  cli.version(pkg.version).help();
  cli.option('--config <path>', 'Path to a Limina config file');
  cli.option('--config-loader <loader>', 'Config loader to use: native, tsx');
  cli.option('--mode <mode>', 'Mode passed to limina config functions');
  cli
    .command('', 'Migrate TypeScript configs into Limina governance')
    .action(runMigrationAction);
  return cli;
}

function assertNoArguments(args: readonly string[]): void {
  if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const invocation = process.argv[1];
  return (
    invocation !== undefined &&
    nodePath.resolve(invocation) === fileURLToPath(import.meta.url)
  );
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    const cli = createMigrationCli();
    cli.parse(argv, { run: false });
    assertNoArguments(cli.args);
    await cli.runMatchedCommand();
  } catch (error) {
    process.stderr.write(`limina-migrate failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) await runCli();
