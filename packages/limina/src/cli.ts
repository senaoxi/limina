#!/usr/bin/env node
import {
  type BuildCheckerPreset,
  type LiminaCommand,
  type LiminaConfigLoader,
  loadConfig,
  type PackageAttwProfile,
  type PackageCheckToolSelection,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { uniqueTrimmedNonEmptySortedStrings } from '#utils/collections';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { cac } from 'cac';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import {
  defaultTaskFailureCode,
  isLiminaCheckIssueCode,
} from './check-reporting/codes';
import {
  type CheckIssueFilterHelpKind,
  type CheckIssueFilterHelpValue,
  formatCheckIssueRuleHelp,
  formatCheckIssueSnapshotFilterHelp,
} from './check-reporting/filter-help';
import {
  type CheckIssueInventoryPresentationOptions,
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  DEFAULT_VISIBLE_ISSUE_LIMIT,
  type InventoryQueryContext,
} from './check-reporting/inventory-presentation';
import { createCheckRunRecorder } from './check-reporting/run-recorder';
import {
  type CheckIssueInventoryFilters,
  type CheckIssueInventoryFormat,
  createTaskFailureIssue,
  formatCheckIssueSnapshotInventory,
  LIMINA_CHECK_TASK_NAMES,
  type LiminaCheckIssue,
  type LiminaCheckTaskName,
  locateCheckIssueWorkspace,
  readCheckIssueSnapshot,
  readStandaloneIssueInvocation,
  toCheckIssueInventoryInvocationMetadata,
  toCheckIssueSnapshot,
  writeStandaloneFailureInvocation,
} from './check-reporting/snapshot';
import {
  createGlobalQueryCommandContext,
  createStandaloneInvocationCommand,
  type GlobalQueryCommandContext,
  renderGeneratedCommandVariants,
} from './check-reporting/standalone-invocation-command';
import { formatCheckRunSummaryHuman } from './check-reporting/summary';
import {
  runGraphCheck,
  runGraphExport,
  runGraphPrepare,
} from './commands/graph';
import { runInit } from './commands/init';
import { runMigration } from './commands/migration';
import { runPackageCheck } from './commands/package';
import { runProofCheck } from './commands/proof';
import { runReleaseCheck } from './commands/release';
import { runSourceCheck } from './commands/source';
import {
  runBuild,
  runCheckerBuild,
  runCheckerTypecheck,
} from './commands/typecheck';
import {
  type DependencyGraphView,
  stringifyDependencyGraph,
} from './dependency-graph/runner';
import type { RunExecutionResult } from './execution/executor';
import {
  createLiminaCheckFlowReporter,
  createLiminaFlowReporter,
} from './flow';
import { clearCliScreen, CliLogger, formatErrorMessage } from './logger';
import {
  createDefaultExecutionPlan,
  createExecutionPlan,
  runDefaultCheckWithResult,
  runPipelineWithResult,
} from './pipeline/runner';
import { LiminaPreflightManager } from './preflight';
import { createProfilingMetricsRecorder } from './profiling/metrics';
import { createCheckProfileSession } from './profiling/session';
import type {
  SourceCheckIssue,
  SourceIssueReportOptions,
} from './source-check/report';
import {
  writeCompletedStandaloneSourceCheckSnapshots,
  writeNotRunSourceIssueSnapshot,
} from './source-check/snapshot';

interface GlobalFlags {
  config?: string;
  configLoader?: string;
  mode?: string;
}

interface PackageSelectionFlags {
  package?: string | string[];
}

interface SourceIssueSelectionFlags extends PackageSelectionFlags {
  file?: string | string[];
  rule?: string | string[];
  scope?: string | string[];
  verbose?: boolean;
}

interface CheckFlags extends GlobalFlags, SourceIssueSelectionFlags {
  checker?: string | string[];
  format?: string;
  invocation?: string;
  issues?: boolean;
  limit?: number | string;
  task?: string | string[];
}

interface SourceFlags extends GlobalFlags, SourceIssueSelectionFlags {}

interface PackageFlags extends GlobalFlags, PackageSelectionFlags {
  attwProfile?: string;
  tool?: string;
  verbose?: boolean;
}

interface CheckerFlags extends GlobalFlags {
  '--'?: string[];
  preset?: string;
  verbose?: boolean;
  w?: boolean;
  watch?: boolean;
}

interface BuildFlags extends GlobalFlags {
  '--'?: string[];
  preset?: string;
  raw?: boolean;
  verbose?: boolean;
  w?: boolean;
  watch?: boolean;
}

interface GraphFlags extends GlobalFlags {
  output?: string;
  verbose?: boolean;
  view?: string;
}

interface ProofFlags extends GlobalFlags {
  verbose?: boolean;
}

interface InitFlags {
  yes?: boolean;
}

type MigrationFlags = GlobalFlags;

async function load(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<ResolvedLiminaConfig> {
  return loadConfig({
    command,
    configLoader: parseConfigLoader(flags.configLoader),
    configPath: flags.config,
    cwd: process.cwd(),
    mode: flags.mode,
  });
}

async function loadStandaloneContext(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<{
  commandContext: GlobalQueryCommandContext;
  config: ResolvedLiminaConfig;
}> {
  const configLoader = parseConfigLoader(flags.configLoader) ?? 'native';
  const mode = flags.mode ?? process.env.NODE_ENV ?? 'default';
  const config = await loadConfig({
    command,
    configLoader,
    configPath: flags.config,
    cwd: process.cwd(),
    mode,
  });

  return {
    commandContext: createGlobalQueryCommandContext({
      configLoader,
      configPath: config.configPath,
      mode,
      workspaceRoot: config.rootDir,
    }),
    config,
  };
}

function parseConfigLoader(
  configLoader: string | undefined,
): LiminaConfigLoader | undefined {
  if (!configLoader) {
    return undefined;
  }

  if (configLoader === 'native' || configLoader === 'tsx') {
    return configLoader;
  }

  throw new Error(
    `Unsupported Limina config loader "${configLoader}". Expected one of: native, tsx.`,
  );
}

function parsePackageTool(
  tool: string | undefined,
): PackageCheckToolSelection | undefined {
  if (!tool) {
    return undefined;
  }

  if (
    tool === 'all' ||
    tool === 'publint' ||
    tool === 'attw' ||
    tool === 'boundary'
  ) {
    return tool;
  }

  throw new Error(
    `Invalid package check --tool "${tool}". Expected one of: all, publint, attw, boundary.`,
  );
}

function parseBuildPreset(
  preset: string | undefined,
  commandLabel = 'checker build',
): BuildCheckerPreset | undefined {
  if (!preset) {
    return undefined;
  }

  if (preset === 'tsc' || preset === 'vue-tsc' || preset === 'tsgo') {
    return preset;
  }

  throw new Error(
    `Invalid ${commandLabel} --preset "${preset}". Expected one of: tsc, vue-tsc, tsgo.`,
  );
}

function rejectUnknownCheckerOptions(flags: CheckerFlags): void {
  const knownOptions = new Set([
    '--',
    'config',
    'configLoader',
    'mode',
    'preset',
    'w',
    'watch',
    'verbose',
  ]);

  for (const option of Object.keys(flags)) {
    if (!knownOptions.has(option)) {
      throw new Error(`Unknown option: --${option}.`);
    }
  }
}

function rejectUnknownBuildOptions(flags: BuildFlags): void {
  const knownOptions = new Set([
    '--',
    'config',
    'configLoader',
    'mode',
    'preset',
    'raw',
    'verbose',
    'w',
    'watch',
  ]);

  for (const option of Object.keys(flags)) {
    if (!knownOptions.has(option)) {
      throw new Error(`Unknown option: --${option}.`);
    }
  }
}

function getCheckerWatchFlag(flags: CheckerFlags): boolean | undefined {
  return flags.watch ?? flags.w;
}

function getBuildWatchFlag(flags: BuildFlags): boolean | undefined {
  return flags.watch ?? flags.w;
}

function parsePackageAttwProfile(
  profile: string | undefined,
): PackageAttwProfile | undefined {
  if (!profile) {
    return undefined;
  }

  if (profile === 'strict' || profile === 'node16' || profile === 'esm-only') {
    return profile;
  }

  throw new Error(
    `Invalid package check --attw-profile "${profile}". Expected one of: strict, node16, esm-only.`,
  );
}

function parsePackageNames(
  packageName: string | string[] | undefined,
): string[] | undefined {
  if (!packageName) {
    return undefined;
  }

  const packageNames = (
    Array.isArray(packageName) ? packageName : [packageName]
  )
    .map((name) => name.trim())
    .filter(Boolean);

  return packageNames.length > 0 ? packageNames : undefined;
}

function parseRepeatedStrings(
  value: string | string[] | undefined,
): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = (Array.isArray(value) ? value : [value])
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function createSourceIssueReportOptions(
  flags: SourceIssueSelectionFlags,
  command: string,
): SourceIssueReportOptions {
  return {
    command,
    files: parseRepeatedStrings(flags.file),
    packageNames: parsePackageNames(flags.package),
    rules: parseRepeatedStrings(flags.rule),
    scopes: parseRepeatedStrings(flags.scope),
    verbose: flags.verbose,
  };
}

function assertKnownCheckRuleCodes(rules: string[] | undefined): void {
  if (!rules) {
    return;
  }

  const unknown = rules.filter((rule) => !isLiminaCheckIssueCode(rule));
  if (unknown.length === 0) {
    return;
  }

  const label = unknown.length > 1 ? 'codes' : 'code';
  const quoted = unknown.map((rule) => `"${rule}"`).join(', ');

  throw new Error(
    [
      `Unknown check --rule ${label} ${quoted}.`,
      'Run `limina check --issues --rule --help` to see supported rule codes.',
    ].join('\n'),
  );
}

function parseIssueInventoryFormat(
  format: string | undefined,
): CheckIssueInventoryFormat | undefined {
  if (!format) {
    return undefined;
  }

  if (format === 'human' || format === 'json' || format === 'ndjson') {
    return format;
  }

  throw new Error(
    `Invalid check --issues --format "${format}". Expected one of: human, json, ndjson.`,
  );
}

function parseIssueInventoryLimit(
  limit: number | string | undefined,
): number | null {
  if (limit === undefined) {
    return DEFAULT_VISIBLE_ISSUE_LIMIT;
  }

  const rawLimit = String(limit);

  if (rawLimit === 'all') {
    return null;
  }

  if (!/^\d+$/u.test(rawLimit)) {
    throw new Error(
      `Invalid check --issues --limit "${rawLimit}". Expected a positive integer or "all".`,
    );
  }

  const parsed = Number(rawLimit);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid check --issues --limit "${rawLimit}". Expected a positive integer or "all".`,
    );
  }

  return parsed;
}

function assertIssueInventoryLimitArgv(argv: readonly string[]): void {
  if (
    getPrimaryCliCommandName(argv) !== 'check' ||
    !argv.includes('--issues')
  ) {
    return;
  }

  const limitArgumentIndex = argv.findIndex(
    (argument) => argument === '--limit' || argument.startsWith('--limit='),
  );

  if (limitArgumentIndex === -1) {
    return;
  }

  const argument = argv[limitArgumentIndex]!;
  const rawLimit = argument.startsWith('--limit=')
    ? argument.slice('--limit='.length)
    : (argv[limitArgumentIndex + 1] ?? '');
  const format =
    parseIssueInventoryFormat(readArgvOptionValue(argv, '--format')) ?? 'human';

  parseIssueInventoryLimit(rawLimit);
  assertHumanIssueInventoryLimit({
    format,
    limitExplicit: true,
  });
}

function getPrimaryCliCommandName(argv: readonly string[]): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    if (
      argument === '--config' ||
      argument === '--config-loader' ||
      argument === '--mode'
    ) {
      index += 1;
      continue;
    }

    if (
      argument?.startsWith('--config=') ||
      argument?.startsWith('--config-loader=') ||
      argument?.startsWith('--mode=')
    ) {
      continue;
    }

    if (argument && !argument.startsWith('-')) {
      return argument;
    }
  }

  return undefined;
}

function assertHumanIssueInventoryLimit(options: {
  format: CheckIssueInventoryFormat;
  limitExplicit: boolean;
}): void {
  if (options.limitExplicit && options.format !== 'human') {
    throw new Error(
      '`limina check --issues --limit` is only available with --format human.',
    );
  }
}

function hasIssueInventoryFilter(filters: CheckIssueInventoryFilters): boolean {
  return Boolean(
    filters.tasks?.length ||
      filters.rules?.length ||
      filters.packageNames?.length ||
      filters.files?.length ||
      filters.scopes?.length ||
      filters.checkerNames?.length,
  );
}

function resolveIssueInventoryPresentation(options: {
  filters: CheckIssueInventoryFilters;
  hasInvocation: boolean;
  limit: number | null;
  limitExplicit: boolean;
  verbose: boolean;
}): CheckIssueInventoryPresentationOptions {
  const hasInventorySelector =
    hasIssueInventoryFilter(options.filters) || options.hasInvocation;

  return {
    maxIssues: options.limit,
    maxPrimaryBlockers: DEFAULT_PRIMARY_BLOCKER_LIMIT,
    view: options.verbose
      ? 'detailed'
      : hasInventorySelector || options.limitExplicit
        ? 'compact'
        : 'summary',
  };
}

function assertStandaloneIssuesFlag(
  pipeline: string | undefined,
  flags: CheckFlags,
): void {
  if (!flags.issues) {
    if (
      flags.task ||
      flags.checker ||
      flags.format ||
      flags.invocation ||
      flags.limit !== undefined
    ) {
      throw new Error(
        '`limina check --task`, `--checker`, `--format`, `--invocation`, and `--limit` require --issues.',
      );
    }

    return;
  }

  if (pipeline) {
    throw new Error('`limina check --issues` does not accept a pipeline name.');
  }
}

function parseDependencyGraphView(
  view: string | undefined,
): DependencyGraphView | undefined {
  if (!view) {
    return undefined;
  }

  if (view === 'all' || view === 'artifact' || view === 'source') {
    return view;
  }

  throw new Error(
    `Invalid graph export --view "${view}". Expected one of: all, artifact, source.`,
  );
}

function isMissingLiminaConfigError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('unable to find limina config')
  );
}

async function loadMigrationConfig(
  flags: MigrationFlags,
): Promise<ResolvedLiminaConfig> {
  try {
    return await load(flags, 'migration');
  } catch (error) {
    if (isMissingLiminaConfigError(error)) {
      throw new Error(
        'Run npx limina init first, then rerun npx limina migration.',
        { cause: error },
      );
    }

    throw error;
  }
}

function createCliFlow(
  options: { check?: boolean; clearScreen?: boolean } = {},
) {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  return options.check
    ? createLiminaCheckFlowReporter()
    : createLiminaFlowReporter();
}

interface CliFlowBoundary {
  close(): Promise<void>;
  outro(message: string): void;
}

async function closeCliFlow(
  flow: CliFlowBoundary,
  message: string,
): Promise<void> {
  let outroError: unknown;
  let closeError: unknown;

  try {
    flow.outro(message);
  } catch (error) {
    outroError = error;
  }
  try {
    await flow.close();
  } catch (error) {
    closeError = error;
  }

  if (outroError !== undefined) {
    if (outroError instanceof Error && closeError !== undefined) {
      Object.defineProperty(outroError, 'flowCloseError', {
        configurable: true,
        value: closeError,
      });
    }
    throw outroError;
  }
  if (closeError !== undefined) throw closeError;
}

async function runCliFlowWithCleanup(
  flow: CliFlowBoundary,
  messages: { failed: string; passed: string },
  execute: () => Promise<boolean>,
): Promise<boolean> {
  let passed = false;
  let primaryError: unknown;
  let closeError: unknown;

  try {
    passed = await execute();
  } catch (error) {
    primaryError = error;
  }

  try {
    await closeCliFlow(flow, passed ? messages.passed : messages.failed);
  } catch (error) {
    closeError = error;
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof Error && closeError !== undefined) {
      Object.defineProperty(primaryError, 'flowCloseError', {
        configurable: true,
        value: closeError,
      });
    }
    throw primaryError;
  }

  if (closeError !== undefined) throw closeError;
  return passed;
}

export function runCheckWithCliFlowCleanup(
  flow: CliFlowBoundary,
  execute: () => Promise<boolean>,
): Promise<boolean> {
  return runCliFlowWithCleanup(
    flow,
    { failed: 'limina check failed', passed: 'limina check passed' },
    execute,
  );
}

interface StandaloneIssueSession {
  command: string;
  commandContext: GlobalQueryCommandContext;
  config: ResolvedLiminaConfig;
  issues: LiminaCheckIssue[];
  preflight: LiminaPreflightManager;
  task: LiminaCheckTaskName;
  title: string;
}

async function writeStandaloneFailureSession(
  session: StandaloneIssueSession,
  error?: unknown,
): Promise<void> {
  const invocation = await writeStandaloneFailureInvocation({
    artifactNamespace: session.preflight.artifactNamespace,
    command: session.command,
    createFallbackIssue: () =>
      createTaskFailureIssue({
        code: defaultTaskFailureCode(session.task),
        filePath: session.config.configPath,
        fix: `Inspect the ${session.title.toLowerCase()} output, then rerun \`${session.command}\`.`,
        reason:
          error === undefined
            ? `${session.title} finished unsuccessfully without structured issue details.`
            : `${session.title} failed: ${formatErrorMessage(error)}.`,
        rootDir: session.config.rootDir,
        task: session.task,
        title: `${session.title} failed`,
      }),
    error,
    issues: session.issues,
    rootDir: session.config.rootDir,
  });
  const generatedCommand = createStandaloneInvocationCommand(
    session.commandContext,
    invocation.invocationId,
  );
  const queryLines = renderGeneratedCommandVariants(generatedCommand).map(
    (variant) => `${variant.label}: ${variant.command}`,
  );

  process.stdout.write(
    `\nStandalone issue invocation: ${invocation.invocationId}\n${queryLines.join('\n')}\n`,
  );
}

async function runStandaloneIssueFlow(options: {
  execute: (
    registerSession: (session: StandaloneIssueSession) => void,
  ) => Promise<boolean>;
  flow: CliFlowBoundary;
  messages: { failed: string; passed: string };
}): Promise<boolean> {
  let commandError: unknown;
  let commandPassed = false;
  let commandSettled = false;
  let finalizationAttempted = false;
  let session: StandaloneIssueSession | undefined;

  const finalize = async (error?: unknown): Promise<void> => {
    if (!session || finalizationAttempted) {
      return;
    }

    finalizationAttempted = true;
    await writeStandaloneFailureSession(session, error);
  };

  try {
    const passed = await runCliFlowWithCleanup(
      options.flow,
      options.messages,
      async () => {
        try {
          commandPassed = await options.execute((nextSession) => {
            session = nextSession;
          });
          commandSettled = true;
          return commandPassed;
        } catch (error) {
          commandError = error;
          throw error;
        }
      },
    );

    if (!passed) {
      await finalize();
    }

    return passed;
  } catch (error) {
    if (session && (!commandSettled || !commandPassed)) {
      await finalize(commandError);
    }

    throw error;
  }
}

function readGlobalFlagsFromArgv(argv: readonly string[]): GlobalFlags {
  const flags: GlobalFlags = {};

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--config') {
      const value = argv[index + 1];

      if (value && !value.startsWith('-')) {
        flags.config = value;
        index += 1;
      }

      continue;
    }

    if (arg?.startsWith('--config=')) {
      flags.config = arg.slice('--config='.length);
      continue;
    }

    if (arg === '--config-loader') {
      const value = argv[index + 1];

      if (value && !value.startsWith('-')) {
        flags.configLoader = value;
        index += 1;
      }

      continue;
    }

    if (arg?.startsWith('--config-loader=')) {
      flags.configLoader = arg.slice('--config-loader='.length);
      continue;
    }

    if (arg === '--mode') {
      const value = argv[index + 1];

      if (value && !value.startsWith('-')) {
        flags.mode = value;
        index += 1;
      }

      continue;
    }

    if (arg?.startsWith('--mode=')) {
      flags.mode = arg.slice('--mode='.length);
    }
  }

  return flags;
}

function readArgvOptionValue(
  argv: readonly string[],
  optionName: string,
): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === optionName) {
      const value = argv[index + 1];
      return value && !value.startsWith('-') ? value : undefined;
    }

    if (arg?.startsWith(`${optionName}=`)) {
      return arg.slice(optionName.length + 1);
    }
  }

  return undefined;
}

function parseCheckIssueFilterHelpKind(
  argv: readonly string[],
): CheckIssueFilterHelpKind | null {
  const args = argv.slice(2);
  let commandName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--config' || arg === '--config-loader' || arg === '--mode') {
      index += 1;
      continue;
    }

    if (
      arg?.startsWith('--config=') ||
      arg?.startsWith('--config-loader=') ||
      arg?.startsWith('--mode=')
    ) {
      continue;
    }

    if (!arg?.startsWith('-')) {
      commandName = arg;
      break;
    }
  }

  if (commandName !== 'check' || !args.includes('--issues')) {
    return null;
  }

  const filters = new Map<string, CheckIssueFilterHelpKind>([
    ['--checker', 'checker'],
    ['--package', 'package'],
    ['-p', 'package'],
    ['--rule', 'rule'],
    ['--task', 'task'],
  ]);

  for (const [index, arg] of args.entries()) {
    const helpKind = filters.get(arg);

    if (!helpKind) {
      continue;
    }

    const nextArg = args[index + 1];

    if (nextArg === '--help' || nextArg === '-h') {
      return helpKind;
    }
  }

  return null;
}

function uniqueSortedValues(
  values: readonly (string | undefined)[],
): CheckIssueFilterHelpValue[] {
  return uniqueTrimmedNonEmptySortedStrings(values).map((name) => ({ name }));
}

function getSnapshotIssuePackageNames(
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>,
): string[] {
  return (
    snapshot?.issues.flatMap((issue) =>
      issue.packageName ? [issue.packageName] : [],
    ) ?? []
  );
}

function getSnapshotIssueCheckerNames(
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>,
): string[] {
  return (
    snapshot?.issues.flatMap((issue) =>
      issue.checkerName ? [issue.checkerName] : [],
    ) ?? []
  );
}

function getCheckIssueTaskHelpValues(
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>,
): CheckIssueFilterHelpValue[] {
  return uniqueSortedValues([
    ...LIMINA_CHECK_TASK_NAMES,
    ...(snapshot?.run?.tasks.map((task) => task.issueTask) ?? []),
    ...(snapshot?.issues.map((issue) => issue.task) ?? []),
  ]);
}

function getCheckIssueCheckerHelpValues(options: {
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>;
}): CheckIssueFilterHelpValue[] {
  return uniqueSortedValues(getSnapshotIssueCheckerNames(options.snapshot));
}

function getCheckIssuePackageHelpValues(options: {
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>;
}): CheckIssueFilterHelpValue[] {
  return uniqueSortedValues(getSnapshotIssuePackageNames(options.snapshot));
}

function getCheckIssueFilterHelpValues(options: {
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
  snapshot: Awaited<ReturnType<typeof readCheckIssueSnapshot>>;
}): CheckIssueFilterHelpValue[] {
  if (options.helpKind === 'task') {
    return getCheckIssueTaskHelpValues(options.snapshot);
  }

  if (options.helpKind === 'checker') {
    return getCheckIssueCheckerHelpValues({
      snapshot: options.snapshot,
    });
  }

  return getCheckIssuePackageHelpValues({
    snapshot: options.snapshot,
  });
}

async function printCheckIssueFilterHelpIfRequested(
  argv: readonly string[],
): Promise<boolean> {
  const helpKind = parseCheckIssueFilterHelpKind(argv);

  if (!helpKind) {
    return false;
  }

  if (helpKind === 'rule') {
    process.stdout.write(`${formatCheckIssueRuleHelp()}\n`);
    return true;
  }

  const globalFlags = readGlobalFlagsFromArgv(argv);
  const location = locateCheckIssueWorkspace({
    configPath: globalFlags.config,
  });
  const invocationId = readArgvOptionValue(argv, '--invocation');
  const snapshot = invocationId
    ? toCheckIssueSnapshot(
        await readStandaloneIssueInvocation(location.rootDir, invocationId),
      )
    : await readCheckIssueSnapshot(location.rootDir);

  process.stdout.write(
    `${formatCheckIssueSnapshotFilterHelp({
      availableValues: getCheckIssueFilterHelpValues({
        helpKind,
        snapshot,
      }),
      helpKind,
      snapshot,
    })}\n`,
  );
  return true;
}

export function createLiminaCli(): ReturnType<typeof cac> {
  const cli = cac('limina');

  cli.option('--config <path>', 'Path to a Limina config file');
  cli.option('--config-loader <loader>', 'Config loader to use: native, tsx');
  cli.option('--mode <mode>', 'Mode passed to limina config functions');
  cli.help();

  cli
    .command('init', 'Initialize Limina files for a pnpm workspace')
    .option('--yes', 'Accept all init prompts')
    .action(async (flags: InitFlags) => {
      await runInit({
        cwd: process.cwd(),
        yes: flags.yes,
      });
    });

  cli
    .command('migration', 'Migrate TypeScript configs into Limina governance')
    .action(async (flags: MigrationFlags) => {
      const flow = createCliFlow();
      const passed = await runCliFlowWithCleanup(
        flow,
        {
          failed: 'limina migration failed',
          passed: 'limina migration passed',
        },
        async () => {
          flow.intro('limina migration');
          const config = await loadMigrationConfig(flags);

          await runMigration(config, {
            flow,
            flowDepth: 1,
          });
          return true;
        },
      );
      if (!passed) process.exitCode = 1;
    });

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
    .action(async (pipeline: string | undefined, flags: CheckFlags) => {
      assertStandaloneIssuesFlag(pipeline, flags);

      if (flags.issues) {
        const format = parseIssueInventoryFormat(flags.format) ?? 'human';
        const limitExplicit = flags.limit !== undefined;
        const limit = parseIssueInventoryLimit(flags.limit);

        assertHumanIssueInventoryLimit({ format, limitExplicit });

        const rules = parseRepeatedStrings(flags.rule);
        assertKnownCheckRuleCodes(rules);

        const filters: CheckIssueInventoryFilters = {
          checkerNames: parseRepeatedStrings(flags.checker),
          files: parseRepeatedStrings(flags.file),
          packageNames: parsePackageNames(flags.package),
          rules,
          scopes: parseRepeatedStrings(flags.scope),
          tasks: parseRepeatedStrings(flags.task),
        };

        const location = locateCheckIssueWorkspace({
          configPath: flags.config,
        });
        const invocation = flags.invocation
          ? await readStandaloneIssueInvocation(
              location.rootDir,
              flags.invocation,
            )
          : undefined;
        const snapshot = invocation
          ? toCheckIssueSnapshot(invocation)
          : await readCheckIssueSnapshot(location.rootDir);
        const invocationMetadata = invocation
          ? toCheckIssueInventoryInvocationMetadata(invocation)
          : undefined;
        const queryContext: InventoryQueryContext = {
          effectiveFormat: 'human',
          filters,
          global: {
            ...(flags.configLoader ? { configLoader: flags.configLoader } : {}),
            ...(location.configPath ? { configPath: location.configPath } : {}),
            ...(flags.mode ? { mode: flags.mode } : {}),
          },
          ...(flags.invocation ? { invocationId: flags.invocation } : {}),
          limit,
          limitExplicit,
          verbose: flags.verbose ?? false,
        };
        const output =
          format === 'human'
            ? formatCheckIssueSnapshotInventory({
                format: 'human',
                ...(invocationMetadata
                  ? { invocation: invocationMetadata }
                  : {}),
                presentation: resolveIssueInventoryPresentation({
                  filters,
                  hasInvocation: Boolean(flags.invocation),
                  limit,
                  limitExplicit,
                  verbose: flags.verbose ?? false,
                }),
                queryContext,
                rootDir: location.rootDir,
                snapshot,
              })
            : formatCheckIssueSnapshotInventory({
                filters,
                format,
                ...(invocationMetadata
                  ? { invocation: invocationMetadata }
                  : {}),
                rootDir: location.rootDir,
                snapshot,
              });

        process.stdout.write(`${output}\n`);
        return;
      }

      const config = await load(flags, 'check');
      const command = pipeline ? `limina check ${pipeline}` : 'limina check';
      const profileMetrics =
        process.env.LIMINA_PROFILE === '1'
          ? createProfilingMetricsRecorder()
          : undefined;
      const preflight = new LiminaPreflightManager({
        config,
        metrics: profileMetrics,
      });
      const profileSession = profileMetrics
        ? await createCheckProfileSession({
            artifactNamespace: preflight.artifactNamespace,
            command,
            metrics: profileMetrics,
          })
        : undefined;
      const packageNames = parsePackageNames(flags.package);
      const sourceIssueReport = {
        ...createSourceIssueReportOptions(flags, command),
        defer: true,
      };
      const checkIssueReport = {
        command: sourceIssueReport.command,
        defer: true,
        verbose: flags.verbose,
      };
      const planOptions = {
        checkIssueReport,
        cwd: process.cwd(),
        packageNames,
        preflight,
        sourceIssueReport,
      };
      const plan = pipeline
        ? createExecutionPlan(config, pipeline, planOptions)
        : createDefaultExecutionPlan(config, planOptions);
      const flow = createCliFlow({
        check: true,
        clearScreen: false,
      });
      let checkRunRecorder:
        | ReturnType<typeof createCheckRunRecorder>
        | undefined;
      let executionResult: RunExecutionResult | undefined;
      let passed = false;
      try {
        passed = await runCheckWithCliFlowCleanup(flow, async () => {
          flow.intro('limina check');
          checkRunRecorder = createCheckRunRecorder({
            command,
            configPath: config.configPath,
            pipeline: pipeline ?? 'default',
            plannedTasks: plan.tasks,
            rootDir: config.rootDir,
          });
          executionResult = pipeline
            ? await runPipelineWithResult(config, pipeline, {
                ...planOptions,
                checkRunRecorder,
                executionPlan: plan,
                flow,
              })
            : await runDefaultCheckWithResult(config, {
                ...planOptions,
                checkRunRecorder,
                executionPlan: plan,
                flow,
              });
          return executionResult.passed;
        });
      } finally {
        await profileSession?.finish({
          passed,
          run: checkRunRecorder?.getRunSummary(),
        });
      }

      if (!passed) {
        process.exitCode = 1;
      }

      const run = checkRunRecorder?.getRunSummary();
      if (executionResult && run) {
        process.stdout.write(
          `\n${formatCheckRunSummaryHuman({
            issues: executionResult.issues,
            queryContext: {
              effectiveFormat: 'human',
              filters: {},
              global: {
                ...(flags.configLoader
                  ? { configLoader: flags.configLoader }
                  : {}),
                ...(flags.config === undefined
                  ? {}
                  : {
                      configPath: normalizeAbsolutePathIdentity(
                        config.configPath,
                      ),
                    }),
                ...(flags.mode ? { mode: flags.mode } : {}),
              },
              limit: DEFAULT_VISIBLE_ISSUE_LIMIT,
              limitExplicit: false,
              verbose: flags.verbose ?? false,
            },
            rootDir: config.rootDir,
            run,
            verbose: flags.verbose,
          })}\n`,
        );
      }
    });

  cli
    .command(
      'graph <action>',
      'Prepare, check, or export TypeScript graph architecture',
    )
    .option('--view <view>', 'Dependency graph view: all, source, or artifact')
    .option('--output <path>', 'Write graph export JSON to this file')
    .option('--verbose', 'Show full graph check issue details')
    .action(async (action: string, flags: GraphFlags) => {
      if (action !== 'check' && action !== 'prepare' && action !== 'export') {
        throw new Error(
          `Unknown graph action "${action}". Expected check, prepare, or export.`,
        );
      }

      if (action === 'export') {
        const config = await load(flags, 'graph');
        const graph = await runGraphExport(config, {
          outputPath: flags.output
            ? path.resolve(process.cwd(), flags.output)
            : undefined,
          view: parseDependencyGraphView(flags.view),
        });

        if (!flags.output) {
          process.stdout.write(stringifyDependencyGraph(graph));
        }

        return;
      }

      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro(`limina graph ${action}`);
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'graph',
          );
          const preflight = new LiminaPreflightManager({ config });
          const command =
            action === 'check' ? 'limina graph check' : 'limina graph prepare';
          const issues: LiminaCheckIssue[] = [];
          registerSession({
            command,
            commandContext,
            config,
            issues,
            preflight,
            task: action === 'check' ? 'graph:check' : 'graph:prepare',
            title: action === 'check' ? 'Graph check' : 'Graph prepare',
          });

          return action === 'check'
            ? runGraphCheck(config, {
                clearScreen: false,
                deferSnapshot: true,
                flow,
                issues,
                preflight,
                report: { command, verbose: flags.verbose },
              })
            : runGraphPrepare(config, {
                clearScreen: false,
                deferSnapshot: true,
                flow,
                issues,
                preflight,
                report: { command, verbose: flags.verbose },
              });
        },
        flow,
        messages: {
          failed: 'limina graph failed',
          passed: 'limina graph passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  cli
    .command('proof <action>', 'Check root typecheck coverage proof')
    .option('--verbose', 'Show full proof check issue details')
    .action(async (action: string, flags: ProofFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown proof action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro('limina proof check');
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'proof',
          );
          const preflight = new LiminaPreflightManager({ config });
          const issues: LiminaCheckIssue[] = [];
          registerSession({
            command: 'limina proof check',
            commandContext,
            config,
            issues,
            preflight,
            task: 'proof:check',
            title: 'Proof check',
          });
          return runProofCheck(config, {
            clearScreen: false,
            deferSnapshot: true,
            flow,
            issues,
            preflight,
            report: {
              command: 'limina proof check',
              verbose: flags.verbose,
            },
          });
        },
        flow,
        messages: {
          failed: 'limina proof failed',
          passed: 'limina proof passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  cli
    .command('source <action>', 'Check source package boundaries')
    .option('-p, --package <name>', 'Filter source issue details by package')
    .option('--verbose', 'Show full source issue details')
    .option('--rule <code>', 'Filter source issue details by stable rule code')
    .option('--file <path>', 'Filter source issue details by exact file path')
    .option('--scope <glob>', 'Filter source issue details by path scope')
    .action(async (action: string, flags: SourceFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown source action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro('limina source check');
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'source',
          );
          const preflight = new LiminaPreflightManager({ config });
          const issues: LiminaCheckIssue[] = [];
          let completedSourceIssues: readonly SourceCheckIssue[] | undefined;
          registerSession({
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
            flow,
            issues,
            onSourceSnapshot: (sourceIssues) => {
              completedSourceIssues = sourceIssues;
            },
            preflight,
            report: createSourceIssueReportOptions(
              flags,
              'limina source check',
            ),
          });

          if (completedSourceIssues) {
            await writeCompletedStandaloneSourceCheckSnapshots({
              artifactNamespace: preflight.artifactNamespace,
              command: 'limina source check',
              issues: completedSourceIssues,
              rootDir: config.rootDir,
            });
          }

          return passed;
        },
        flow,
        messages: {
          failed: 'limina source failed',
          passed: 'limina source passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  cli
    .command('build <config>', 'Build user-facing artifacts')
    .option('--preset <preset>', 'Build checker preset: tsc, vue-tsc, or tsgo')
    .option('--raw', 'Run the selected checker directly against the config')
    .option('-w, --watch', 'Watch input files and rebuild on changes')
    .option('--verbose', 'Show full build issue details')
    .allowUnknownOptions()
    .action(async (configPath: string, flags: BuildFlags) => {
      rejectUnknownBuildOptions(flags);

      const watch = getBuildWatchFlag(flags);

      if (flags.raw && !flags.preset) {
        throw new Error('limina build --raw requires --preset.');
      }

      const checker = parseBuildPreset(flags.preset, 'build');
      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro('limina build');
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'build',
          );
          const preflight = new LiminaPreflightManager({ config });
          const issues: LiminaCheckIssue[] = [];
          registerSession({
            command: 'limina build',
            commandContext,
            config,
            issues,
            preflight,
            task: 'checker:build',
            title: 'Build',
          });
          const result = await runBuild({
            checker,
            clearScreen: false,
            config,
            configPath,
            cwd: process.cwd(),
            deferSnapshot: true,
            flow,
            issues,
            preflight,
            raw: flags.raw,
            report: {
              command: 'limina build',
              verbose: flags.verbose,
            },
            watch,
          });
          return result.passed;
        },
        flow,
        messages: {
          failed: 'limina build failed',
          passed: 'limina build passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  cli
    .command(
      'checker <action> [config]',
      'Run checker build or typecheck entries',
    )
    .option('--preset <preset>', 'Build checker preset: tsc, vue-tsc, or tsgo')
    .option('-w, --watch', 'Watch input files and rebuild on changes')
    .option('--verbose', 'Show full checker issue details')
    .allowUnknownOptions()
    .action(
      async (
        action: string,
        configPath: string | undefined,
        flags: CheckerFlags,
      ) => {
        rejectUnknownCheckerOptions(flags);

        if (action !== 'typecheck' && action !== 'build') {
          throw new Error(
            `Unknown checker action "${action}". Expected build or typecheck.`,
          );
        }

        const flow = createCliFlow();
        const passed = await runStandaloneIssueFlow({
          execute: async (registerSession) => {
            flow.intro(`limina checker ${action}`);

            if (action === 'build') {
              const watch = getCheckerWatchFlag(flags);

              if (!configPath && flags.preset) {
                throw new Error(
                  'checker build --preset requires a config argument.',
                );
              }

              if (!configPath && watch) {
                throw new Error(
                  'checker build --watch requires a config argument.',
                );
              }

              const { commandContext, config } = await loadStandaloneContext(
                flags,
                configPath ? 'build' : 'check',
              );
              const preflight = new LiminaPreflightManager({ config });
              const issues: LiminaCheckIssue[] = [];
              registerSession({
                command: 'limina checker build',
                commandContext,
                config,
                issues,
                preflight,
                task: 'checker:build',
                title: 'Checker build',
              });
              const result = await runCheckerBuild({
                ...(configPath
                  ? {
                      checker: parseBuildPreset(flags.preset),
                      configPath,
                      watch,
                    }
                  : {}),
                clearScreen: false,
                config,
                cwd: process.cwd(),
                deferSnapshot: true,
                flow,
                issues,
                preflight,
                report: {
                  command: 'limina checker build',
                  verbose: flags.verbose,
                },
              });
              return result.passed;
            }

            if (configPath) {
              throw new Error(
                'checker typecheck does not accept a config argument.',
              );
            }
            if (flags.preset) {
              throw new Error('checker typecheck does not accept --preset.');
            }
            if (getCheckerWatchFlag(flags)) {
              throw new Error('checker typecheck does not accept --watch.');
            }

            const { commandContext, config } = await loadStandaloneContext(
              flags,
              'check',
            );
            const preflight = new LiminaPreflightManager({ config });
            const issues: LiminaCheckIssue[] = [];
            registerSession({
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
              flow,
              issues,
              preflight,
              report: {
                command: 'limina checker typecheck',
                verbose: flags.verbose,
              },
            });
            return result.passed;
          },
          flow,
          messages: {
            failed: 'limina checker failed',
            passed: 'limina checker passed',
          },
        });
        if (!passed) process.exitCode = 1;
      },
    );

  cli
    .command('package <action>', 'Check configured published package outputs')
    .option('-p, --package <name>', 'Run one package check entry')
    .option('--tool <tool>', 'Run one package check tool')
    .option('--attw-profile <profile>', 'Override the configured ATTW profile')
    .option('--verbose', 'Show full package check issue details')
    .action(async (action: string, flags: PackageFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown package action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro('limina package check');
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'package',
          );
          const preflight = new LiminaPreflightManager({ config });
          const issues: LiminaCheckIssue[] = [];
          registerSession({
            command: 'limina package check',
            commandContext,
            config,
            issues,
            preflight,
            task: 'package:check',
            title: 'Package check',
          });
          return runPackageCheck({
            attwProfile: parsePackageAttwProfile(flags.attwProfile),
            clearScreen: false,
            config,
            cwd: process.cwd(),
            deferSnapshot: true,
            flow,
            issues,
            preflight,
            packageNames: parsePackageNames(flags.package),
            report: {
              command: 'limina package check',
              verbose: flags.verbose,
            },
            tool: parsePackageTool(flags.tool),
          });
        },
        flow,
        messages: {
          failed: 'limina package failed',
          passed: 'limina package passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  cli
    .command('release <action>', 'Check package release readiness')
    .option('-p, --package <name>', 'Run one release check package entry')
    .option('--verbose', 'Show full release check issue details')
    .action(async (action: string, flags: CheckFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown release action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      const passed = await runStandaloneIssueFlow({
        execute: async (registerSession) => {
          flow.intro('limina release check');
          const { commandContext, config } = await loadStandaloneContext(
            flags,
            'release',
          );
          const preflight = new LiminaPreflightManager({ config });
          const issues: LiminaCheckIssue[] = [];
          registerSession({
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
            flow,
            issues,
            preflight,
            packageNames: parsePackageNames(flags.package),
            report: {
              command: 'limina release check',
              verbose: flags.verbose,
            },
          });
        },
        flow,
        messages: {
          failed: 'limina release failed',
          passed: 'limina release passed',
        },
      });

      if (!passed) {
        process.exitCode = 1;
      }
    });

  return cli;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = createLiminaCli();

  try {
    assertIssueInventoryLimitArgv(argv);

    if (await printCheckIssueFilterHelpIfRequested(argv)) {
      return;
    }

    cli.parse(argv, { run: false });

    const commandName = cli.args[0];

    if (!cli.matchedCommand && commandName) {
      throw new Error(`Unknown command "${commandName}".`);
    }

    await cli.runMatchedCommand();
  } catch (error) {
    CliLogger.error(`limina failed: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

const cliModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && nodePath.resolve(process.argv[1]) === cliModulePath) {
  await runCli(process.argv);
}
