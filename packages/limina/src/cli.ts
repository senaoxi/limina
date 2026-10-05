import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIssueInventoryLimitArgv,
  parseCheckIssueFilterHelpKind,
} from './cli/argv';
import { createLiminaCli } from './cli/factory';
import { isPrintCheckIssueFilterHelpIfRequested } from './cli/filter-help';
import { isForwardMigrationIfRequested } from './cli/migration-forward';
import { clearCliScreen, CliLogger, formatErrorMessage } from './logger';

export { createLiminaCli } from './cli/factory';
export { runCheckWithCliFlowCleanup } from './cli/flow';

function assertMatchedCommand(cli: ReturnType<typeof createLiminaCli>): void {
  const commandName = cli.args[0];
  if (commandName === undefined || cli.matchedCommand) return;
  throw new Error(`Unknown command "${commandName}".`);
}

function assertCheckCommandArguments(
  cli: ReturnType<typeof createLiminaCli>,
): void {
  if (cli.matchedCommand?.name === 'check') {
    cli.matchedCommand.checkUnknownOptions();
  }
}

export async function executeCli(argv: string[]): Promise<void> {
  if (await isForwardMigrationIfRequested(argv)) return;
  await executeProductCli(argv);
}

async function executeProductCli(argv: string[]): Promise<void> {
  clearCliScreen();

  const cli = createLiminaCli();
  cli.showHelpOnExit = parseCheckIssueFilterHelpKind(argv) === null;
  let isDisplayedCommandHelp = false;
  cli.globalCommand.helpCallback = (sections) => {
    assertCheckCommandArguments(cli);
    // CAC clears matchedCommand after displaying help; preserve that outcome.
    isDisplayedCommandHelp = cli.matchedCommand !== undefined;
    return sections;
  };
  cli.parse(argv, { run: false });
  assertCheckCommandArguments(cli);
  assertIssueInventoryLimitArgv(argv);
  if (
    isDisplayedCommandHelp ||
    (await isPrintCheckIssueFilterHelpIfRequested(argv))
  ) {
    return;
  }
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
