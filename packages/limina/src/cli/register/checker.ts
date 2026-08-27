import type { cac } from 'cac';
import { runCheckerBuild, runCheckerTypecheck } from '../../commands/typecheck';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import {
  getCheckerWatchFlag,
  parseBuildPreset,
  rejectUnknownCheckerOptions,
} from '../parse';
import { runStandaloneIssueFlow } from '../standalone';
import type { CheckerFlags, RegisterStandaloneIssueSession } from '../types';

type LiminaCli = ReturnType<typeof cac>;
type CheckerAction = 'build' | 'typecheck';

function parseCheckerAction(action: string): CheckerAction {
  if (action === 'build' || action === 'typecheck') return action;
  throw new Error(
    `Unknown checker action "${action}". Expected build or typecheck.`,
  );
}

interface CheckerTargetOptions {
  configPath: string | undefined;
  flags: CheckerFlags;
}

function assertBuildPresetHasConfig(options: CheckerTargetOptions): void {
  if (options.configPath !== undefined) return;
  if (options.flags.preset === undefined) return;
  throw new Error('checker build --preset requires a config argument.');
}

function assertBuildWatchHasConfig(options: CheckerTargetOptions): void {
  if (options.configPath !== undefined) return;
  if (!getCheckerWatchFlag(options.flags)) return;
  throw new Error('checker build --watch requires a config argument.');
}

function validateCheckerBuildFlags(options: CheckerTargetOptions): void {
  assertBuildPresetHasConfig(options);
  assertBuildWatchHasConfig(options);
}

function assertTypecheckHasNoConfig(options: CheckerTargetOptions): void {
  if (options.configPath === undefined) return;
  throw new Error('checker typecheck does not accept a config argument.');
}

function assertTypecheckHasNoPreset(options: CheckerTargetOptions): void {
  if (options.flags.preset === undefined) return;
  throw new Error('checker typecheck does not accept --preset.');
}

function assertTypecheckHasNoWatch(options: CheckerTargetOptions): void {
  if (!getCheckerWatchFlag(options.flags)) return;
  throw new Error(
    'checker typecheck does not accept --watch; rerun it after source config, parser package, generated type, or framework source changes.',
  );
}

function validateCheckerTypecheckFlags(options: CheckerTargetOptions): void {
  assertTypecheckHasNoConfig(options);
  assertTypecheckHasNoPreset(options);
  assertTypecheckHasNoWatch(options);
}

async function executeCheckerBuild(options: {
  configPath: string | undefined;
  flags: CheckerFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: RegisterStandaloneIssueSession;
}): Promise<boolean> {
  validateCheckerBuildFlags(options);
  const commandKind = options.configPath === undefined ? 'check' : 'build';
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    commandKind,
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command: 'limina checker build',
    commandContext,
    config,
    issues,
    preflight,
    task: 'checker:build',
    title: 'Checker build',
  });
  const targetOptions =
    options.configPath === undefined
      ? {}
      : {
          checker: parseBuildPreset(options.flags.preset),
          configPath: options.configPath,
          watch: getCheckerWatchFlag(options.flags),
        };
  const result = await runCheckerBuild({
    ...targetOptions,
    clearScreen: false,
    config,
    cwd: process.cwd(),
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    report: {
      command: 'limina checker build',
      verbose: options.flags.verbose,
    },
  });
  return result.passed;
}

async function executeCheckerTypecheck(options: {
  configPath: string | undefined;
  flags: CheckerFlags;
  flow: ReturnType<typeof createCliFlow>;
  registerSession: RegisterStandaloneIssueSession;
}): Promise<boolean> {
  validateCheckerTypecheckFlags(options);
  const { commandContext, config } = await loadStandaloneContext(
    options.flags,
    'check',
  );
  const preflight = new LiminaPreflightManager({ config });
  const issues: LiminaCheckIssue[] = [];
  options.registerSession({
    command: 'limina checker typecheck',
    commandContext,
    config,
    issues,
    preflight,
    task: 'checker:typecheck',
    title: 'Checker typecheck',
  });
  const result = await runCheckerTypecheck({
    clearScreen: false,
    config,
    cwd: process.cwd(),
    deferSnapshot: true,
    flow: options.flow,
    issues,
    preflight,
    report: {
      command: 'limina checker typecheck',
      verbose: options.flags.verbose,
    },
  });
  return result.passed;
}

async function runCheckerAction(
  action: string,
  configPath: string | undefined,
  flags: CheckerFlags,
): Promise<void> {
  rejectUnknownCheckerOptions(flags);
  const parsedAction = parseCheckerAction(action);
  const flow = createCliFlow();
  const passed = await runStandaloneIssueFlow({
    execute: (registerSession) => {
      flow.intro(`limina checker ${parsedAction}`);
      const options = { configPath, flags, flow, registerSession };
      return parsedAction === 'build'
        ? executeCheckerBuild(options)
        : executeCheckerTypecheck(options);
    },
    flow,
    messages: {
      failed: 'limina checker failed',
      passed: 'limina checker passed',
    },
  });
  if (!passed) process.exitCode = 1;
}

export function registerCheckerCommand(cli: LiminaCli): void {
  cli
    .command(
      'checker <action> [config]',
      'Run checker build or typecheck entries',
    )
    .option('--preset <preset>', 'Build checker preset: tsc, vue-tsc, or tsgo')
    .option('-w, --watch', 'Watch input files and rebuild on changes')
    .option('--verbose', 'Show full checker issue details')
    .allowUnknownOptions()
    .action(runCheckerAction);
}
