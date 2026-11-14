import { type ChildProcess, spawn } from 'node:child_process';
import {
  type InternalProcessEntry,
  resolveInternalProcessEntry,
} from '../execution/internal-process-entry';
import {
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  createCancelledCheckerMeasurement,
  spawnAndMeasure,
} from './host-protocol';
import {
  type CheckerHostDegradationListener,
  CheckerProcessHost,
  notifyCheckerHostDegraded,
  resetCheckerHostDegradationNotice,
} from './process-host-core';

export type { CheckerHostDegradationListener } from './process-host-core';

function resolveCheckerHostEntry(
  moduleUrl: string = import.meta.url,
): InternalProcessEntry | undefined {
  return resolveInternalProcessEntry({
    bundleFileName: 'checker-host-process.js',
    moduleUrl,
    sourceFileName: 'host-process.ts',
    sourceLoader: 'direct',
  });
}

export const resolveCheckerHostEntryForTesting: typeof resolveCheckerHostEntry =
  resolveCheckerHostEntry;
const activeHosts = new Set<CheckerProcessHost>();

async function runSupervisor(options: {
  entry: InternalProcessEntry;
  spec: CheckerHostSpawnSpec;
  startedAt: number;
  onDegraded?: CheckerHostDegradationListener;
  onProtocolMessage?: (message: unknown) => void;
  signal?: AbortSignal;
}): Promise<CheckerHostSpawnMeasurement> {
  let child: ChildProcess;
  try {
    child = spawn(options.entry.command, options.entry.args, {
      detached: true,
      env: process.env,
      stdio: [options.spec.stdio, 'inherit', 'inherit', 'ipc'],
    });
  } catch (error) {
    notifyCheckerHostDegraded(
      `checker supervisor failed before dispatch: ${String(error)}`,
      options.onDegraded,
    );
    const result = await spawnAndMeasure(options.spec, {
      signal: options.signal,
    });
    return { ...result, durationMs: performance.now() - options.startedAt };
  }
  const host = new CheckerProcessHost(child, options.onProtocolMessage);
  activeHosts.add(host);
  try {
    return await host.spawnMeasured(
      options.spec,
      options.onDegraded,
      options.signal,
      options.startedAt,
    );
  } finally {
    activeHosts.delete(host);
  }
}

export async function runCheckerSpawnMeasured(
  spec: CheckerHostSpawnSpec,
  options: {
    onDegraded?: CheckerHostDegradationListener;
    signal?: AbortSignal;
  } = {},
): Promise<CheckerHostSpawnMeasurement> {
  if (options.signal?.aborted)
    return createCancelledCheckerMeasurement(options.signal);
  const startedAt = performance.now();
  const isDisabled =
    process.env.LIMINA_CHECKER_HOST === 'off' || process.platform === 'win32';
  const entry = isDisabled ? undefined : resolveCheckerHostEntry();
  if (entry !== undefined)
    return runSupervisor({ ...options, entry, spec, startedAt });
  notifyCheckerHostDegraded(
    isDisabled
      ? 'checker supervisor disabled or unavailable on this platform — executing directly'
      : 'checker supervisor entry could not be resolved — executing directly',
    options.onDegraded,
  );
  const result = await spawnAndMeasure(spec, { signal: options.signal });
  return { ...result, durationMs: performance.now() - startedAt };
}

export async function runCheckerHostProtocolProbeForTesting(options: {
  entry: { args: readonly string[]; command: string };
  onDegraded?: CheckerHostDegradationListener;
  onProtocolMessage?: (message: unknown) => void;
  signal?: AbortSignal;
  spec: CheckerHostSpawnSpec;
}): Promise<CheckerHostSpawnMeasurement> {
  if (options.signal?.aborted)
    return createCancelledCheckerMeasurement(options.signal);
  return runSupervisor({
    ...options,
    entry: { ...options.entry, args: [...options.entry.args] },
    startedAt: performance.now(),
  });
}

export async function disposeCheckerProcessHostForTesting(): Promise<void> {
  await Promise.all([...activeHosts].map((host) => host.dispose()));
  resetCheckerHostDegradationNotice();
}
