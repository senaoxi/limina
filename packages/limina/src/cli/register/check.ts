import type { cac } from 'cac';
import { runConfiguredCheck } from '../check-run';
import { showIssueInventory } from '../issue-query';
import { assertStandaloneIssuesFlag } from '../parse';
import type { CheckFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

async function runCheckAction(
  pipeline: string | undefined,
  flags: CheckFlags,
): Promise<void> {
  assertStandaloneIssuesFlag(pipeline, flags);
  if (flags.issues === true) {
    await showIssueInventory(flags);
    return;
  }
  await runConfiguredCheck({ flags, pipeline });
}

export function registerCheckCommand(cli: LiminaCli): void {
  cli
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
      '--limit <limit>',
      'Limit human issue cards to a positive integer or all',
    )
    .option(
      '--invocation <uuid>',
      'Read one standalone failure invocation instead of the last check run',
    )
    .option('--format <format>', 'Issue output format: human, json, or ndjson')
    .action(runCheckAction);
}
