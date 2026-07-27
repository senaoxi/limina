import type { cac } from 'cac';
import { runBuild } from '../../commands/typecheck';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import {
  getBuildWatchFlag,
  parseBuildPreset,
  rejectUnknownBuildOptions,
} from '../parse';
import { runStandaloneIssueFlow } from '../standalone';
import type { BuildFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

function assertRawPreset(flags: BuildFlags): void {
  if (flags.raw !== true || flags.preset !== undefined) return;
  throw new Error('limina build --raw requires --preset.');
}

async function executeBuild(options: {
  configPath: string;
  flags: BuildFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: Parameters<
    typeof runStandaloneIssueFlow
  >[0]['execute'] extends (register: infer Register) => Promise<boolean>
    ? Register
    : never;
}): Promise<boolean> {
  options.flow.intro('limina build');
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'build',
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command: 'limina build',
    commandContext,
    config,
    issues,
    preflight,
    task: 'checker:build',
    title: 'Build',
  });
  const result = await runBuild({
    checker: parseBuildPreset(options.flags.preset, 'build'),
    clearScreen: false,
    config,
    configPath: options.configPath,
    cwd: process.cwd(),
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    raw: options.flags.raw,
    report: {
      command: 'limina build',
      verbose: options.flags.verbose,
    },
    watch: getBuildWatchFlag(options.flags),
  });
  return result.passed;
}

async function runBuildAction(
  configPath: string,
  flags: BuildFlags,
): Promise<void> {
  rejectUnknownBuildOptions(flags);
  assertRawPreset(flags);
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) =>
      executeBuild({ configPath, flags, flow, registerSession }),
    flow,
    messages: {
      failed: 'limina build failed',
      passed: 'limina build passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

export function registerBuildCommand(cli: LiminaCli): void {
  cli
    .command('build <config>', 'Build user-facing artifacts')
    .option('--preset <preset>', 'Build checker preset: tsc, vue-tsc, or tsgo')
    .option('--raw', 'Run the selected checker directly against the config')
    .option('-w, --watch', 'Watch input files and rebuild on changes')
    .option('--verbose', 'Show full build issue details')
    .allowUnknownOptions()
    .action(runBuildAction);
}
