import type { cac } from 'cac';
import { runConfiguredCheck } from '../check-run';
import { showIssueInventory } from '../issue-query';
import { assertStandaloneIssuesFlag } from '../parse';
import type { CheckFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;
type LiminaCheckCommand = ReturnType<LiminaCli['command']>;

function isStructuredCheckOption(value: unknown): boolean {
  // Check has no structured options; CAC accepts dotted keys under known names.
  return typeof value === 'object' && !Array.isArray(value);
}

function hasUnknownNamedCheckOptions(
  cli: LiminaCli,
  command: LiminaCheckCommand,
): boolean {
  if (cli.args[0] === undefined) return false;
  const knownOptions = new Set(
    [...command.options, ...cli.globalCommand.options].flatMap(
      (option) => option.names,
    ),
  );
  knownOptions.add('--');
  return Object.entries(cli.options).some(
    ([name, value]) =>
      !knownOptions.has(name) || isStructuredCheckOption(value),
  );
}

function hasCheckRuntimeArguments(
  cli: LiminaCli,
  command: LiminaCheckCommand,
): boolean {
  return (
    cli.args.length > 1 ||
    cli.rawArgs.slice(2).includes('--') ||
    hasUnknownNamedCheckOptions(cli, command)
  );
}

function createCheckRuntimeArgumentsError(pipeline: string | undefined): Error {
  const commandLabel =
    pipeline === undefined ? 'limina check' : `limina check ${pipeline}`;
  const instruction =
    pipeline === undefined
      ? 'Use `limina check --help` for Limina CLI options.'
      : `Configure the pipeline in the Limina config under \`pipelines.${pipeline}\`.`;
  return new Error(
    `\`${commandLabel}\` does not accept runtime arguments.\n${instruction}`,
  );
}

function assertCheckRuntimeArguments(cli: LiminaCli): void {
  const command = cli.matchedCommand;
  if (command === undefined || !hasCheckRuntimeArguments(cli, command)) return;
  throw createCheckRuntimeArgumentsError(cli.args[0]);
}

async function runCheckAction(
  pipeline: string | undefined,
  flags: CheckFlags,
): Promise<void> {
  assertStandaloneIssuesFlag(pipeline, flags);
  assertAnalysisCacheFlags(flags);
  if (flags.issues === true) {
    await showIssueInventory(flags);
    return;
  }
  await runConfiguredCheck({ flags, pipeline });
}

export function registerCheckCommand(cli: LiminaCli): void {
  const command = cli
    .command(
      'check [pipeline]',
      'Run the default check or a configured pipeline',
    )
    .option(
      '-p, --package <name>',
      'Run package-aware pipeline tasks for one package entry',
    )
    .option('--verbose', 'Expand check summaries or show detailed issue cards')
    .option('--rule <code>', 'Filter check issue details by stable rule code')
    .option('--file <path>', 'Filter check issue details by exact file path')
    .option('--scope <glob>', 'Filter check issue details by path scope')
    .option('--task <name>', 'Filter issue inventory by stable task name')
    .option('--checker <name>', 'Filter issue inventory by checker')
    .option('--issues', 'Show issues from the last completed check')
    .option(
      '--no-analysis-cache',
      'Disable persistent Limina analysis cache reads and writes',
    )
    .option(
      '--limit <limit>',
      'Limit human issue cards to a positive integer or all',
    )
    .option(
      '--invocation <uuid>',
      'Read one standalone failure invocation instead of the last check run',
    )
    .option('--format <format>', 'Issue output format: human, json, or ndjson')
    .action(runCheckAction);
  // Validate synchronously before CAC can enter the action or config loading.
  const checkUnknownOptions = command.checkUnknownOptions.bind(command);
  command.checkUnknownOptions = () => {
    assertCheckRuntimeArguments(cli);
    checkUnknownOptions();
  };
}

function assertAnalysisCacheFlags(flags: CheckFlags): void {
  if (flags.issues === true && flags.analysisCache === false)
    throw new Error('--no-analysis-cache cannot be combined with --issues.');
}
