import type { cac } from 'cac';
import { runSourceCheck } from '../../commands/source';
import { LiminaPreflightManager } from '../../preflight';
import type { SourceCheckIssue } from '../../source-check/report';
import {
  type LiminaCheckIssue,
  writeCompletedStandaloneSourceCheckSnapshots,
  writeNotRunSourceIssueSnapshot,
} from '../../source-check/snapshot';
import { loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import { createSourceIssueReportOptions } from '../parse';
import { runStandaloneIssueFlow } from '../standalone';
import type { SourceFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

function assertSourceAction(action: string): void {
  if (action === 'check') return;
  throw new Error(`Unknown source action "${action}". Expected check.`);
}

async function executeSourceCheck(options: {
  flags: SourceFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: Parameters<
    typeof runStandaloneIssueFlow
  >[0]['execute'] extends (register: infer Register) => Promise<boolean>
    ? Register
    : never;
}): Promise<boolean> {
  options.flow.intro('limina source check');
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'source',
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  let completedSourceIssues: readonly SourceCheckIssue[] | undefined;
  options.registerSession({
    command: 'limina source check',
    commandContext,
    config,
    issues,
    preflight,
    task: 'source:check',
    title: 'Source check',
  });
  await writeNotRunSourceIssueSnapshot({
    artifactNamespace: preflight.artifactNamespace,
    command: 'limina source check',
    rootDir: config.rootDir,
  });
  const passed = await runSourceCheck(config, {
    clearScreen: false,
    deferSnapshot: true,
    flow: options.flow,
    issues,
    onSourceSnapshot: (sourceIssues) => {
      completedSourceIssues = sourceIssues;
    },
    preflight,
    report: createSourceIssueReportOptions(
      options.flags,
      'limina source check',
    ),
  });
  if (completedSourceIssues !== undefined) {
    await writeCompletedStandaloneSourceCheckSnapshots({
      artifactNamespace: preflight.artifactNamespace,
      command: 'limina source check',
      issues: completedSourceIssues,
      rootDir: config.rootDir,
    });
  }
  return passed;
}

async function runSourceAction(
  action: string,
  flags: SourceFlags,
): Promise<void> {
  assertSourceAction(action);
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) =>
      executeSourceCheck({ flags, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina source failed',
      passed: 'limina source passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

export function registerSourceCommand(cli: LiminaCli): void {
  cli
    .command('source <action>', 'Check source package boundaries')
    .option('-p, --package <name>', 'Filter source issue details by package')
    .option('--verbose', 'Show full source issue details')
    .option('--rule <code>', 'Filter source issue details by stable rule code')
    .option('--file <path>', 'Filter source issue details by exact file path')
    .option('--scope <glob>', 'Filter source issue details by path scope')
    .action(runSourceAction);
}
