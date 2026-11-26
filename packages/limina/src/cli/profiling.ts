import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AnalysisObserver,
  type AnalysisProfile,
  currentProfile,
  runWithProfile,
} from '../application/analysis/observability';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { readArgvOptionValue } from './argv';
import type { createLiminaCli } from './factory';

type LiminaCli = ReturnType<typeof createLiminaCli>;
const RSS_SAMPLE_INTERVAL_MS = 50;

class CliAnalysisObserver extends AnalysisObserver {
  namespace?: LiminaArtifactNamespace;
}

export interface CliProfiling {
  readonly entry: 'source' | 'distribution' | undefined;
  readonly fromEnvironment: boolean;
  readonly startedAt: number;
  active?: CliProfileState;
}

interface CliProfileState {
  cwd: string;
  observer: CliAnalysisObserver;
  outputDirectory: string | undefined;
  stderr: 'silent' | 'summary' | 'verbose';
  finishRss: () => void;
}

function hasProfileArgument(argv: readonly string[]): boolean {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') return false;
    if (
      argument === '--profile' ||
      argument === '--profile-output' ||
      argument?.startsWith('--profile=') ||
      argument?.startsWith('--profile-output=')
    )
      return true;
  }
  return false;
}

export function beginCliProfiling(
  argv: readonly string[],
  cliModuleUrl: string,
): CliProfiling | undefined {
  const isFromEnvironment = process.env.LIMINA_PROFILE === '1';
  if (!isFromEnvironment && !hasProfileArgument(argv)) return undefined;
  const startedAt = performance.now();
  const entry = cliModuleUrl.endsWith('/src/cli.ts')
    ? 'source'
    : cliModuleUrl.endsWith('/cli.js')
      ? 'distribution'
      : undefined;
  return { entry, fromEnvironment: isFromEnvironment, startedAt };
}

function argumentsBeforeForwarding(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf('--', 2);
  return separator === -1 ? argv : argv.slice(0, separator);
}

function readOutputDirectoryFlag(cli: LiminaCli): string | undefined {
  const value: unknown = cli.options.profileOutput;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const directory = readArgvOptionValue(
    argumentsBeforeForwarding(cli.rawArgs),
    '--profile-output',
  );
  return directory !== undefined && directory.trim() !== ''
    ? directory
    : undefined;
}

function getCommandLabel(
  command: string | undefined,
  action: string | undefined,
): string | undefined {
  switch (command) {
    case 'check': {
      return action === undefined ? 'limina check' : 'limina check pipeline';
    }
    case 'graph': {
      return ['check', 'prepare', 'export'].includes(action ?? '')
        ? `limina graph ${action}`
        : 'limina graph';
    }
    case 'source': {
      return action === 'check' ? 'limina source check' : 'limina source';
    }
    default: {
      return undefined;
    }
  }
}

function getProfileCommand(cli: LiminaCli): string | undefined {
  return cli.matchedCommand?.name === 'check' && cli.options?.issues === true
    ? undefined
    : getCommandLabel(cli.matchedCommand?.name, cli.args[0]);
}

export function assertCliProfileArgv(argv: readonly string[]): void {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') return;
    // CAC treats other inline boolean values as positional arguments.
    if (
      argument !== '--profile=true' &&
      argument !== '--profile=false' &&
      argument?.startsWith('--profile=')
    )
      throw new Error('--profile does not take a value.');
  }
}

export function getCliProfileOptionsError(cli: LiminaCli): Error | undefined {
  const profile: unknown = cli.options?.profile;
  if (profile !== undefined && typeof profile !== 'boolean')
    return new Error('--profile does not take a value.');
  if (
    cli.options?.profileOutput !== undefined &&
    readOutputDirectoryFlag(cli) === undefined
  )
    return new Error('--profile-output requires a directory.');
  return (profile === true || cli.options?.profileOutput !== undefined) &&
    getProfileCommand(cli) === undefined
    ? new Error(
        'Profiling is available for check, graph check, graph prepare, graph export and source check.',
      )
    : undefined;
}

function sampleRss(observer: AnalysisObserver): () => void {
  let peakRssBytes = 0;
  let finalRssBytes = 0;
  let rssSamples = 0;
  const sample = () => {
    try {
      finalRssBytes = process.memoryUsage.rss();
      peakRssBytes = Math.max(peakRssBytes, finalRssBytes);
      rssSamples += 1;
    } catch {
      // RSS can be unavailable in a constrained runtime.
    }
  };
  sample();
  const timer = setInterval(sample, RSS_SAMPLE_INTERVAL_MS).unref();
  return () => {
    clearInterval(timer);
    sample();
    if (rssSamples === 0) return;
    observer.runtime({
      finalRssBytes,
      peakRssBytes,
      rssSamples,
      rssSampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
    });
  };
}

function recordRuntime(
  observer: AnalysisObserver,
  entry: CliProfiling['entry'],
): void {
  const work = observer.start('profile.runtime-metadata');
  try {
    const { version } = createRequire(import.meta.url)(
      'limina/package.json',
    ) as {
      version: string;
    };
    observer.runtime({ entry, limina: version });
    observer.finish(work);
  } catch {
    observer.finish(work, 'failed', 'runtime-metadata-unavailable');
  }
}

function createCliProfileState(options: {
  command: string;
  directory: string | undefined;
  profiling: CliProfiling;
  stderr: CliProfileState['stderr'];
}): CliProfileState | undefined {
  try {
    const cwd = process.cwd();
    const outputDirectory =
      options.directory === undefined
        ? undefined
        : path.resolve(cwd, options.directory);
    const observer = new CliAnalysisObserver(
      options.command,
      options.profiling.startedAt,
    );
    recordRuntime(observer, options.profiling.entry);
    return {
      cwd,
      finishRss: sampleRss(observer),
      observer,
      outputDirectory,
      stderr: options.stderr,
    };
  } catch {
    return undefined;
  }
}

export function captureProfiledParseFailure(
  profiling: CliProfiling,
  cli: LiminaCli,
): void {
  if (getCliProfileOptionsError(cli) !== undefined) return;
  const command = getProfileCommand(cli);
  const directory = readOutputDirectoryFlag(cli);
  if (command === undefined || directory === undefined) return;
  profiling.active = createCliProfileState({
    command,
    directory,
    profiling,
    stderr: cli.options.verbose === true ? 'verbose' : 'summary',
  });
}

export async function executeProfiledCommand(options: {
  cli: LiminaCli;
  execute: () => Promise<void>;
  isHelp: boolean;
  profiling: CliProfiling | undefined;
}): Promise<void> {
  const { cli, profiling } = options;
  if (profiling === undefined || options.isHelp) return options.execute();
  const command = getProfileCommand(cli);
  if (command === undefined) return options.execute();
  const isExplicit =
    cli.options.profile === true || cli.options.profileOutput !== undefined;
  if (
    !isExplicit &&
    !(profiling.fromEnvironment && cli.matchedCommand?.name === 'check')
  )
    return options.execute();
  const active = createCliProfileState({
    command,
    directory: readOutputDirectoryFlag(cli),
    profiling,
    stderr: isExplicit
      ? cli.options.verbose === true
        ? 'verbose'
        : 'summary'
      : 'silent',
  });
  if (active === undefined) return options.execute();
  profiling.active = active;
  let isEnteredCommand = false;
  try {
    return await runWithProfile(active.observer, () => {
      isEnteredCommand = true;
      return options.execute();
    });
  } catch (error) {
    if (isEnteredCommand) throw error;
    profiling.active = undefined;
    active.finishRss();
    return options.execute();
  }
}

export async function finishCliProfiling(
  profiling: CliProfiling,
  isPassed: boolean,
  error: unknown,
): Promise<void> {
  const active = profiling.active;
  if (active === undefined) return;
  const { observer } = active;
  let profile: AnalysisProfile;
  try {
    try {
      observer.stop(isPassed, error);
    } finally {
      active.finishRss();
    }
    profile = observer.snapshot();
  } catch {
    // A projection failure must preserve the command outcome.
    return;
  }
  const { namespace } = observer;
  if (namespace === undefined && observer.root !== undefined) return;
  try {
    const { emitAnalysisProfile } = await import('../profiling/report');
    await emitAnalysisProfile({
      cwd: active.cwd,
      namespace,
      outputDirectory: active.outputDirectory,
      profile,
      stderr: active.stderr,
      failureDetail: (work) => observer.failureDetail(work),
    });
  } catch {
    // An unavailable observer or its output must preserve the command outcome.
  }
}

export function bindCliProfileRoot(rootDirectory: string): void {
  const observer = currentProfile();
  if (observer === undefined) return;
  try {
    observer.setRoot(rootDirectory);
    if (observer instanceof CliAnalysisObserver) {
      const work = observer.start('profile.namespace-binding');
      try {
        observer.namespace = createLiminaArtifactNamespace({
          generation: 0,
          rootDir: rootDirectory,
        });
        observer.finish(work);
      } catch {
        observer.finish(work, 'failed', 'profile-namespace-unavailable');
      }
    }
  } catch {
    // A profile cannot change configuration admission.
  }
}

export async function observeCliPhase<T>(
  operation: string,
  execute: () => Promise<T>,
): Promise<T> {
  const observer = currentProfile();
  if (observer === undefined) return execute();
  const work = observer.start(operation);
  try {
    const result = await observer.inWork(work, execute);
    observer.finish(work);
    return result;
  } catch (error) {
    observer.fail(work, error);
    throw error;
  }
}
