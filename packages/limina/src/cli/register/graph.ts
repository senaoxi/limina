import type { cac } from 'cac';
import path from 'pathe';
import {
  runGraphCheck,
  runGraphExport,
  runGraphPrepare,
} from '../../commands/graph';
import { stringifyDependencyGraph } from '../../dependency-graph/runner';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadCliConfig, loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import { parseDependencyGraphView } from '../parse';
import { runStandaloneIssueFlow } from '../standalone';
import type { GraphFlags, RegisterStandaloneIssueSession } from '../types';

type LiminaCli = ReturnType<typeof cac>;
type GraphAction = 'check' | 'export' | 'prepare';
type GraphValidationAction = Exclude<GraphAction, 'export'>;

const GRAPH_ACTIONS = new Set<string>(['check', 'export', 'prepare']);

function parseGraphAction(action: string): GraphAction {
  if (GRAPH_ACTIONS.has(action)) return action as GraphAction;
  throw new Error(
    `Unknown graph action "${action}". Expected check, prepare, or export.`,
  );
}

function getValidationDescriptor(action: GraphValidationAction) {
  if (action === 'check') {
    return {
      run: runGraphCheck,
      task: 'graph:check' as const,
      title: 'Graph check',
    };
  }
  return {
    run: runGraphPrepare,
    task: 'graph:prepare' as const,
    title: 'Graph prepare',
  };
}

async function runGraphExportAction(flags: GraphFlags): Promise<void> {
  const config = await loadCliConfig(flags, 'graph');
  const graph = await runGraphExport(config, {
    outputPath: flags.output
      ? path.resolve(process.cwd(), flags.output)
      : undefined,
    view: parseDependencyGraphView(flags.view),
  });
  if (flags.output === undefined) {
    process.stdout.write(stringifyDependencyGraph(graph));
  }
}

async function executeGraphValidation(options: {
  action: GraphValidationAction;
  flags: GraphFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: RegisterStandaloneIssueSession;
}): Promise<boolean> {
  const descriptor = getValidationDescriptor(options.action);
  options.flow.intro(`limina graph ${options.action}`);
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'graph',
  );
  const preflight = new LiminaPreflightManager({ config });
  const command = `limina graph ${options.action}`;
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command,
    commandContext,
    config,
    issues,
    preflight,
    task: descriptor.task,
    title: descriptor.title,
  });
  return descriptor.run(config, {
    clearScreen: false,
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    report: { command, verbose: options.flags.verbose },
  });
}

async function runGraphValidationAction(options: {
  action: GraphValidationAction;
  flags: GraphFlags;
}): Promise<void> {
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) =>
      executeGraphValidation({ ...options, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina graph failed',
      passed: 'limina graph passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

async function runGraphAction(
  action: string,
  flags: GraphFlags,
): Promise<void> {
  const parsed = parseGraphAction(action);
  if (parsed === 'export') {
    await runGraphExportAction(flags);
    return;
  }
  await runGraphValidationAction({ action: parsed, flags });
}

export function registerGraphCommand(cli: LiminaCli): void {
  cli
    .command(
      'graph <action>',
      'Prepare, check, or export TypeScript graph architecture',
    )
    .option('--view <view>', 'Dependency graph view: all, source, or artifact')
    .option('--output <path>', 'Write graph export JSON to this file')
    .option('--verbose', 'Show full graph check issue details')
    .action(runGraphAction);
}
