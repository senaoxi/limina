import type { ResolvedLiminaConfig } from '#config/runner';
import { planCapabilitySubscriptions } from '#core';
import type { cac } from 'cac';
import path from 'pathe';
import { currentProfile } from '../../application/analysis/observability';
import {
  isRunGraphCheck,
  isRunGraphPrepare,
  runGraphExport,
} from '../../commands/graph';
import { stringifyDependencyGraph } from '../../dependency-graph/runner';
import { runObservedTask } from '../../execution/task-observers';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadCliConfig, loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import { parseDependencyGraphView } from '../parse';
import { isRunStandaloneIssueFlow } from '../standalone';
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
      run: isRunGraphCheck,
      task: 'graph:check' as const,
      title: 'Graph check',
    };
  }
  return {
    run: isRunGraphPrepare,
    task: 'graph:prepare' as const,
    title: 'Graph prepare',
  };
}

async function exportGraph(
  config: ResolvedLiminaConfig,
  flags: GraphFlags,
): Promise<void> {
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

async function runGraphExportAction(flags: GraphFlags): Promise<void> {
  const config = await loadCliConfig(flags, 'graph');
  const observer = currentProfile();
  if (observer === undefined) {
    await exportGraph(config, flags);
    return;
  }
  observer.setPolicy(config.cache === false ? 'disabled' : 'read-only');
  const taskId = 'standalone-task';
  let runnerUs: number | undefined;
  let isPassed = false;
  try {
    await runObservedTask({
      observer,
      operation: 'execution.standalone-action',
      taskId,
      execute: async () => {
        const startedAt = performance.now();
        try {
          await exportGraph(config, flags);
        } finally {
          runnerUs = Math.round((performance.now() - startedAt) * 1000);
        }
      },
      isPassed: () => true,
    });
    isPassed = true;
  } finally {
    try {
      observer.task(taskId, {
        name: 'graph:export',
        runnerUs,
        state: isPassed ? 'passed' : 'failed',
      });
    } catch {
      // Profiling does not own the export result.
    }
  }
}

async function isExecuteGraphValidation(options: {
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
  currentProfile()?.setPolicy(
    config.cache === false
      ? 'disabled'
      : options.action === 'prepare'
        ? 'read-write'
        : 'read-only',
  );
  const preflight = new LiminaPreflightManager({
    config,
    analysisCache: options.action === 'prepare' || 'read-only',
    subscriptionPlan: planCapabilitySubscriptions([descriptor.task]),
  });
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
  const isPassed = await descriptor.run(config, {
    clearScreen: false,
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    report: { command, verbose: options.flags.verbose },
  });
  if (isPassed && options.action === 'prepare')
    await preflight.publishAnalysisCache();
  return isPassed;
}

async function runGraphValidationAction(options: {
  action: GraphValidationAction;
  flags: GraphFlags;
}): Promise<void> {
  const flow = createCliFlow();
  const isPassed = await isRunStandaloneIssueFlow({
    execute: (registerSession) =>
      isExecuteGraphValidation({ ...options, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina graph failed',
      passed: 'limina graph passed',
    },
  });
  if (!isPassed) process.exitCode = 1;
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
