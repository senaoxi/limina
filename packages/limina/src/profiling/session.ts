import { performance } from 'node:perf_hooks';
import path from 'pathe';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import type { LiminaCheckRunSummary } from '../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  collectRuntimeTreeIdentity,
  type RuntimeTreeIdentity,
} from './identity';
import type { ProfilingMetricsRecorder } from './metrics';

const SHA256_PATTERN = /^[a-f\d]{64}$/u;
const RSS_SAMPLE_INTERVAL_MS = 50;

export interface CheckProfileSession {
  freeze(options: {
    passed: boolean;
    run?: LiminaCheckRunSummary;
    trace?: object;
  }): () => Promise<void>;
}

interface ProfileSessionState {
  readonly buildInputHash?: string;
  readonly command: string;
  readonly createdAt: string;
  readonly metrics: ProfilingMetricsRecorder;
  readonly runtime: RuntimeTreeIdentity;
  readonly startedAt: number;
}

export interface ProfileRuntimeExpectations {
  buildInputHash: string | undefined;
  executablePath: string | undefined;
  packagePath: string | undefined;
  runtimeTreeHash: string | undefined;
}

function readOptionalEnvironment(name: string): string | undefined {
  const value = process.env[name];

  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function assertSha256Hash(name: string, value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash.`);
  }
}

function parseExpectedHash(
  name: string,
  configuredValue: string | undefined,
): string | undefined {
  if (configuredValue === undefined) {
    return undefined;
  }

  const value = configuredValue.toLowerCase();
  assertSha256Hash(name, value);
  return value;
}

function assertExpectedValue(options: {
  actual: string;
  expected: string | undefined;
  label: string;
}): void {
  if (options.expected === undefined) {
    return;
  }

  if (options.actual !== options.expected) {
    throw new Error(
      `${options.label} mismatch: expected ${options.expected}, received ${options.actual}.`,
    );
  }
}

function readExpectedPath(name: string): string | undefined {
  const value = readOptionalEnvironment(name);
  return value === undefined ? undefined : path.resolve(value);
}

function assertExpectedIdentity(
  identity: RuntimeTreeIdentity,
  expected: ProfileRuntimeExpectations,
): void {
  assertExpectedValue({
    actual: identity.treeHash,
    expected: parseExpectedHash(
      'LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH',
      expected.runtimeTreeHash,
    ),
    label: 'Linked Limina runtime tree hash',
  });
  assertExpectedValue({
    actual: identity.packageRealPath,
    expected: expected.packagePath,
    label: 'Linked Limina package realpath',
  });
  assertExpectedValue({
    actual: identity.executableRealPath,
    expected: expected.executablePath,
    label: 'Linked Limina executable realpath',
  });
}

export function readProfileRuntimeExpectations(): ProfileRuntimeExpectations {
  return {
    buildInputHash: readOptionalEnvironment('LIMINA_PROFILE_BUILD_INPUT_HASH'),
    executablePath: readExpectedPath(
      'LIMINA_PROFILE_EXPECTED_EXECUTABLE_REALPATH',
    ),
    packagePath: readExpectedPath('LIMINA_PROFILE_EXPECTED_PACKAGE_REALPATH'),
    runtimeTreeHash: readOptionalEnvironment(
      'LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH',
    ),
  };
}

export async function qualifyProfileRuntime(
  expected: ProfileRuntimeExpectations,
): Promise<RuntimeTreeIdentity> {
  const executableLogicalPath = path.resolve(process.argv[1] ?? '');
  const packageLogicalPath = path.dirname(path.dirname(executableLogicalPath));
  const runtime = await collectRuntimeTreeIdentity({
    executableLogicalPath,
    packageLogicalPath,
  });
  assertExpectedIdentity(runtime, expected);
  return runtime;
}

function createBuildMetadata(
  buildInputHash: string | undefined,
): { inputHash: string } | undefined {
  return buildInputHash === undefined
    ? undefined
    : { inputHash: buildInputHash };
}

function readRss(): number | undefined {
  try {
    return process.memoryUsage.rss();
  } catch {
    return undefined;
  }
}

function createProcessMetadata(peakRssBytes: number | undefined): {
  arch: string;
  finalRssBytes?: number;
  nodeVersion: string;
  peakRssBytes?: number;
  pid: number;
  platform: NodeJS.Platform;
} {
  return {
    arch: process.arch,
    finalRssBytes: readRss(),
    nodeVersion: process.version,
    peakRssBytes,
    pid: process.pid,
    platform: process.platform,
  };
}

function createProfilePayload(options: {
  completedAt: string;
  passed: boolean;
  peakRssBytes: number | undefined;
  run?: LiminaCheckRunSummary;
  trace?: object;
  state: ProfileSessionState;
}): object {
  return {
    build: createBuildMetadata(options.state.buildInputHash),
    command: options.state.command,
    completedAt: options.completedAt,
    createdAt: options.state.createdAt,
    durationMs: Math.max(0, performance.now() - options.state.startedAt),
    metrics: options.state.metrics.snapshot(),
    process: createProcessMetadata(options.peakRssBytes),
    result: options.passed ? 'passed' : 'failed',
    run: options.run,
    runtime: options.state.runtime,
    trace: options.trace,
    durationScope:
      'profile session after runtime identity collection through payload creation; excludes profile write and summary output',
    cliTraceScope:
      'runConfiguredCheck entry through preflight disposal; excludes module loader, profile write, summary output and process exit',
    runDurationScope:
      'first task lifecycle start through analysis cache publication; excludes final issue snapshot writes',
    taskDurationScope:
      'runner wall interval, inclusive of nested graph preparation, admission, resources and child execution; not CPU time',
    schemaVersion: 1,
  };
}

function getProfilePath(namespace: LiminaArtifactNamespace): string {
  return path.join(namespace.rootDir, 'check', 'last-profile.json');
}

export function createCheckProfileSession(options: {
  artifactNamespace: LiminaArtifactNamespace;
  buildInputHash: string | undefined;
  command: string;
  metrics: ProfilingMetricsRecorder;
  runtime: RuntimeTreeIdentity;
}): CheckProfileSession {
  const state: ProfileSessionState = {
    buildInputHash: parseExpectedHash(
      'LIMINA_PROFILE_BUILD_INPUT_HASH',
      options.buildInputHash,
    ),
    command: options.command,
    createdAt: new Date(
      performance.timeOrigin + performance.now(),
    ).toISOString(),
    metrics: options.metrics,
    runtime: options.runtime,
    startedAt: performance.now(),
  };
  let peakRssBytes = readRss();
  function sampleRss(): void {
    const rss = readRss();
    if (rss !== undefined) peakRssBytes = Math.max(peakRssBytes ?? 0, rss);
  }
  const sampler = setInterval(sampleRss, RSS_SAMPLE_INTERVAL_MS);
  sampler.unref();

  return Object.freeze({
    freeze(result: {
      passed: boolean;
      run?: LiminaCheckRunSummary;
      trace?: object;
    }): () => Promise<void> {
      clearInterval(sampler);
      sampleRss();
      const completedAt = new Date(
        performance.timeOrigin + performance.now(),
      ).toISOString();
      const payload = createProfilePayload({
        completedAt,
        passed: result.passed,
        peakRssBytes,
        run: result.run,
        trace: result.trace,
        state,
      });
      return () =>
        writeJsonAtomically(
          options.artifactNamespace,
          getProfilePath(options.artifactNamespace),
          payload,
        );
    },
  });
}
