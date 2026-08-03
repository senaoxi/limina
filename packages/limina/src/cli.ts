#!/usr/bin/env node
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIssueInventoryLimitArgv } from './cli/argv';
import { createLiminaCli } from './cli/factory';
import { printCheckIssueFilterHelpIfRequested } from './cli/filter-help';
import { clearCliScreen, CliLogger, formatErrorMessage } from './logger';

export { createLiminaCli } from './cli/factory';
export { runCheckWithCliFlowCleanup } from './cli/flow';

function assertMatchedCommand(cli: ReturnType<typeof createLiminaCli>): void {
  const commandName = cli.args[0];
  if (cli.matchedCommand || commandName === undefined) return;
  throw new Error(`Unknown command "${commandName}".`);
}

export async function executeCli(argv: string[]): Promise<void> {
  clearCliScreen();

  assertIssueInventoryLimitArgv(argv);
  if (await printCheckIssueFilterHelpIfRequested(argv)) return;
  const cli = createLiminaCli();
  cli.parse(argv, { run: false });
  assertMatchedCommand(cli);
  await cli.runMatchedCommand();
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await executeCli(argv);
  } catch (error) {
    CliLogger.error(`limina failed: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function isDirectCliExecution(): boolean {
  const invocationPath = process.argv[1];
  if (invocationPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  return nodePath.resolve(invocationPath) === modulePath;
}

if (isDirectCliExecution()) await runCli(process.argv);
