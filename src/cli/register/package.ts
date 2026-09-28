import type { cac } from 'cac';
import { runPackageCheck } from '../../commands/package';
import { runReleaseCheck } from '../../commands/release';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import {
  parsePackageAttwProfile,
  parsePackageNames,
  parsePackageTool,
} from '../parse';
import { runStandaloneIssueFlow } from '../standalone';
import type { CheckFlags, PackageFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

function assertCheckAction(action: string, domain: string): void {
  if (action === 'check') return;
  throw new Error(`Unknown ${domain} action "${action}". Expected check.`);
}

async function executePackageCheck(options: {
  flags: PackageFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: Parameters<
    typeof runStandaloneIssueFlow
  >[0]['execute'] extends (register: infer Register) => Promise<boolean>
    ? Register
    : never;
}): Promise<boolean> {
  options.flow.intro('limina package check');
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'package',
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command: 'limina package check',
    commandContext,
    config,
    issues,
    preflight,
    task: 'package:check',
    title: 'Package check',
  });
  return runPackageCheck({
    attwProfile: parsePackageAttwProfile(options.flags.attwProfile),
    clearScreen: false,
    config,
    cwd: process.cwd(),
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    packageNames: parsePackageNames(options.flags.package),
    report: {
      command: 'limina package check',
      verbose: options.flags.verbose,
    },
    tool: parsePackageTool(options.flags.tool),
  });
}

async function runPackageAction(
  action: string,
  flags: PackageFlags,
): Promise<void> {
  assertCheckAction(action, 'package');
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) =>
      executePackageCheck({ flags, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina package failed',
      passed: 'limina package passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

async function executeReleaseCheck(options: {
  flags: CheckFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: Parameters<
    typeof runStandaloneIssueFlow
  >[0]['execute'] extends (register: infer Register) => Promise<boolean>
    ? Register
    : never;
}): Promise<boolean> {
  options.flow.intro('limina release check');
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'release',
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command: 'limina release check',
    commandContext,
    config,
    issues,
    preflight,
    task: 'release:check',
    title: 'Release check',
  });
  return runReleaseCheck({
    clearScreen: false,
    config,
    cwd: process.cwd(),
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    packageNames: parsePackageNames(options.flags.package),
    report: {
      command: 'limina release check',
      verbose: options.flags.verbose,
    },
  });
}

async function runReleaseAction(
  action: string,
  flags: CheckFlags,
): Promise<void> {
  assertCheckAction(action, 'release');
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) =>
      executeReleaseCheck({ flags, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina release failed',
      passed: 'limina release passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

export function registerPackageCommands(cli: LiminaCli): void {
  cli
    .command('package <action>', 'Check configured published package outputs')
    .option('-p, --package <name>', 'Run one package check entry')
    .option('--tool <tool>', 'Run one package check tool')
    .option('--attw-profile <profile>', 'Override the configured ATTW profile')
    .option('--verbose', 'Show full package check issue details')
    .action(runPackageAction);
  cli
    .command('release <action>', 'Check package release readiness')
    .option('-p, --package <name>', 'Run one release check package entry')
    .option('--verbose', 'Show full release check issue details')
    .action(runReleaseAction);
}
