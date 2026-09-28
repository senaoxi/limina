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
  readonly metrics: ProfilingMetricsRecorder;
  finish(options: {
    passed: boolean;
    run?: LiminaCheckRunSummary;
  }): Promise<void>;
}

interface ProfileSessionState {
  readonly buildInputHash?: string;
  readonly command: string;
  readonly createdAt: string;
  readonly metrics: ProfilingMetricsRecorder;
  readonly runtime: RuntimeTreeIdentity;
  readonly startedAt: number;
}

function readOptionalEnv(name: string): string | undefined {
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

function readExpectedHash(name: string): string | undefined {
  const configuredValue = readOptionalEnv(name);

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

function resolveExpectedPath(name: string): string | undefined {
  const value = readOptionalEnv(name);
  return value === undefined ? undefined : path.resolve(value);
}

function assertExpectedIdentity(identity: RuntimeTreeIdentity): void {
  assertExpectedValue({
    actual: identity.treeHash,
    expected: readExpectedHash('LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH'),
    label: 'Linked Limina runtime tree hash',
  });
  assertExpectedValue({
    actual: identity.packageRealPath,
    expected: resolveExpectedPath('LIMINA_PROFILE_EXPECTED_PACKAGE_REALPATH'),
    label: 'Linked Limina package realpath',
  });
  assertExpectedValue({
    actual: identity.executableRealPath,
    expected: resolveExpectedPath(
      'LIMINA_PROFILE_EXPECTED_EXECUTABLE_REALPATH',
    ),
    label: 'Linked Limina executable realpath',
  });
}

function createBuildMetadata(
  buildInputHash: string | undefined,
): { inputHash: string } | undefined {
  return buildInputHash === undefined
    ? undefined
    : { inputHash: buildInputHash };
}

function createProcessMetadata(peakRssBytes: number): {
  arch: string;
  finalRssBytes: number;
  nodeVersion: string;
  peakRssBytes: number;
  pid: number;
  platform: NodeJS.Platform;
} {
  return {
    arch: process.arch,
    finalRssBytes: process.memoryUsage.rss(),
    nodeVersion: process.version,
    peakRssBytes,
    pid: process.pid,
    platform: process.platform,
  };
}

function createProfilePayload(options: {
  completedAt: string;
  passed: boolean;
  peakRssBytes: number;
  run?: LiminaCheckRunSummary;
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
    schemaVersion: 1,
  };
}

function getProfilePath(namespace: LiminaArtifactNamespace): string {
  return path.join(namespace.rootDir, 'check', 'last-profile.json');
}

export async function createCheckProfileSession(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  metrics: ProfilingMetricsRecorder;
}): Promise<CheckProfileSession | undefined> {
  if (process.env.LIMINA_PROFILE !== '1') {
    return undefined;
  }

  const executableLogicalPath = path.resolve(process.argv[1] ?? '');
  const packageLogicalPath = path.dirname(path.dirname(executableLogicalPath));
  const runtime = await collectRuntimeTreeIdentity({
    executableLogicalPath,
    packageLogicalPath,
  });
  assertExpectedIdentity(runtime);

  const state: ProfileSessionState = {
    buildInputHash: readExpectedHash('LIMINA_PROFILE_BUILD_INPUT_HASH'),
    command: options.command,
    createdAt: new Date().toISOString(),
    metrics: options.metrics,
    runtime,
    startedAt: performance.now(),
  };
  let peakRssBytes = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }, RSS_SAMPLE_INTERVAL_MS);
  sampler.unref();

  return Object.freeze({
    async finish(result: {
      passed: boolean;
      run?: LiminaCheckRunSummary;
    }): Promise<void> {
      clearInterval(sampler);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
      await writeJsonAtomically(
        options.artifactNamespace,
        getProfilePath(options.artifactNamespace),
        createProfilePayload({
          completedAt: new Date().toISOString(),
          passed: result.passed,
          peakRssBytes,
          run: result.run,
          state,
        }),
      );
    },
    metrics: options.metrics,
  });
}
