import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIssueInventoryLimitArgv,
  parseCheckIssueFilterHelpKind,
} from './cli/argv';
import { createLiminaCli } from './cli/factory';
import { isPrintCheckIssueFilterHelpIfRequested } from './cli/filter-help';
import { isForwardMigrationIfRequested } from './cli/migration-forward';
import {
  assertCliProfileArgv,
  beginCliProfiling,
  captureProfiledParseFailure,
  type CliProfiling,
  executeProfiledCommand,
  finishCliProfiling,
  getCliProfileOptionsError,
} from './cli/profiling';
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

export async function executeCli(
  argv: string[],
  profiling?: CliProfiling,
): Promise<void> {
  if (await isForwardMigrationIfRequested(argv)) return;
  await executeProductCli(argv, profiling);
}

async function executeProductCli(
  argv: string[],
  profiling: CliProfiling | undefined,
): Promise<void> {
  clearCliScreen();
  assertCliProfileArgv(argv);

  const cli = createLiminaCli();
  cli.showHelpOnExit = parseCheckIssueFilterHelpKind(argv) === null;
  let isDisplayedCommandHelp = false;
  cli.globalCommand.helpCallback = (sections) => {
    assertCheckCommandArguments(cli);
    // CAC clears matchedCommand after displaying help; preserve that outcome.
    isDisplayedCommandHelp = cli.matchedCommand !== undefined;
    return sections;
  };
  try {
    cli.parse(argv, { run: false });
  } catch (error) {
    if (profiling !== undefined) captureProfiledParseFailure(profiling, cli);
    throw error;
  }
  const profileOptionsError = getCliProfileOptionsError(cli);
  const execute = () =>
    executeMatchedProductCli(
      cli,
      argv,
      isDisplayedCommandHelp,
      profileOptionsError,
    );
  if (profiling === undefined || profileOptionsError !== undefined)
    return execute();
  return executeProfiledCommand({
    cli,
    isHelp: isDisplayedCommandHelp || cli.options.help === true,
    profiling,
    execute,
  });
}

async function executeMatchedProductCli(
  cli: ReturnType<typeof createLiminaCli>,
  argv: string[],
  isDisplayedCommandHelp: boolean,
  profileOptionsError: Error | undefined,
): Promise<void> {
  assertCheckCommandArguments(cli);
  assertIssueInventoryLimitArgv(argv);
  if (
    isDisplayedCommandHelp ||
    (await isPrintCheckIssueFilterHelpIfRequested(argv))
  )
    return;
  assertMatchedCommand(cli);
  if (profileOptionsError !== undefined) throw profileOptionsError;
  await cli.runMatchedCommand();
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const profiling = beginCliProfiling(argv, import.meta.url);
  let failure: unknown;
  try {
    await executeCli(argv, profiling);
  } catch (error) {
    failure = error;
    CliLogger.error(`limina failed: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    if (profiling !== undefined)
      await finishCliProfiling(
        profiling,
        Number(process.exitCode ?? 0) === 0,
        failure,
      );
  }
}

function isDirectCliExecution(): boolean {
  const invocationPath = process.argv[1];
  if (invocationPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  return nodePath.resolve(invocationPath) === modulePath;
}

if (isDirectCliExecution()) await runCli(process.argv);
