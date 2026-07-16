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

function readExpectedHash(name: string): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function assertExpectedIdentity(identity: RuntimeTreeIdentity): void {
  const expectedTreeHash = readExpectedHash(
    'LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH',
  );
  if (expectedTreeHash && identity.treeHash !== expectedTreeHash) {
    throw new Error(
      `Linked Limina runtime tree hash mismatch: expected ${expectedTreeHash}, received ${identity.treeHash}.`,
    );
  }

  const expectedPackageRealPath =
    process.env.LIMINA_PROFILE_EXPECTED_PACKAGE_REALPATH?.trim();
  if (
    expectedPackageRealPath &&
    path.resolve(expectedPackageRealPath) !== identity.packageRealPath
  ) {
    throw new Error(
      `Linked Limina package realpath mismatch: expected ${expectedPackageRealPath}, received ${identity.packageRealPath}.`,
    );
  }

  const expectedExecutableRealPath =
    process.env.LIMINA_PROFILE_EXPECTED_EXECUTABLE_REALPATH?.trim();
  if (
    expectedExecutableRealPath &&
    path.resolve(expectedExecutableRealPath) !== identity.executableRealPath
  ) {
    throw new Error(
      `Linked Limina executable realpath mismatch: expected ${expectedExecutableRealPath}, received ${identity.executableRealPath}.`,
    );
  }
}

export async function createCheckProfileSession(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  metrics: ProfilingMetricsRecorder;
}): Promise<CheckProfileSession | undefined> {
  if (process.env.LIMINA_PROFILE !== '1') return undefined;

  const executableLogicalPath = path.resolve(process.argv[1] ?? '');
  const packageLogicalPath = path.dirname(path.dirname(executableLogicalPath));
  const runtime = await collectRuntimeTreeIdentity({
    executableLogicalPath,
    packageLogicalPath,
  });
  assertExpectedIdentity(runtime);
  const buildInputHash = readExpectedHash('LIMINA_PROFILE_BUILD_INPUT_HASH');
  const createdAt = new Date().toISOString();
  const startedAt = performance.now();
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
      const completedAt = new Date().toISOString();
      await writeJsonAtomically(
        options.artifactNamespace,
        path.join(
          options.artifactNamespace.rootDir,
          'check',
          'last-profile.json',
        ),
        {
          build: buildInputHash ? { inputHash: buildInputHash } : undefined,
          command: options.command,
          completedAt,
          createdAt,
          durationMs: Math.max(0, performance.now() - startedAt),
          metrics: options.metrics.snapshot(),
          process: {
            arch: process.arch,
            finalRssBytes: process.memoryUsage.rss(),
            nodeVersion: process.version,
            peakRssBytes,
            pid: process.pid,
            platform: process.platform,
          },
          result: result.passed ? 'passed' : 'failed',
          run: result.run,
          runtime,
          schemaVersion: 1,
        },
      );
    },
    metrics: options.metrics,
  });
}
