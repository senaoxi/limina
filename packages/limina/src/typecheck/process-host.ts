import { spawn } from 'node:child_process';
import {
  type InternalProcessEntry,
  resolveInternalProcessEntry,
} from '../execution/internal-process-entry';
import {
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  spawnAndMeasure,
} from './host-protocol';
import {
  type CheckerHostDegradationListener,
  CheckerProcessHost,
  notifyCheckerHostDegraded,
  resetCheckerHostDegradationNotice,
} from './process-host-core';

export type { CheckerHostDegradationListener } from './process-host-core';

type CheckerHostEntry = InternalProcessEntry;

function resolveCheckerHostEntry(
  moduleUrl: string = import.meta.url,
): CheckerHostEntry | undefined {
  return resolveInternalProcessEntry({
    bundleFileName: 'checker-host-process.js',
    moduleUrl,
    sourceFileName: 'host-process.ts',
  });
}

export const resolveCheckerHostEntryForTesting: typeof resolveCheckerHostEntry =
  resolveCheckerHostEntry;

const state = {
  sharedHost: undefined as CheckerProcessHost | undefined,
  isSharedHostUnavailable: false,
};

function isHostDisabled(
  onDegraded: CheckerHostDegradationListener | undefined,
): boolean {
  if (process.env.LIMINA_CHECKER_HOST !== 'off') {
    return false;
  }

  notifyCheckerHostDegraded(
    'LIMINA_CHECKER_HOST=off — durations measured in-process',
    onDegraded,
  );
  return true;
}

function isActiveHost(
  host: CheckerProcessHost | undefined,
): host is CheckerProcessHost {
  return host !== undefined && host.active;
}

function markSharedHostUnavailable(): void {
  state.sharedHost = undefined;
  state.isSharedHostUnavailable = true;
}

function createSharedCheckerHost(
  onDegraded: CheckerHostDegradationListener | undefined,
): CheckerProcessHost | undefined {
  const entry = resolveCheckerHostEntry();
  if (entry === undefined) {
    markSharedHostUnavailable();
    notifyCheckerHostDegraded(
      'checker host entry could not be resolved — durations measured in-process',
      onDegraded,
    );
    return undefined;
  }

  const child = spawn(entry.command, entry.args, {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  state.sharedHost = new CheckerProcessHost(
    child,
    undefined,
    markSharedHostUnavailable,
  );
  return state.sharedHost;
}

function resolveAvailableSharedHost(
  onDegraded: CheckerHostDegradationListener | undefined,
): CheckerProcessHost | undefined {
  if (state.isSharedHostUnavailable) {
    return undefined;
  }

  return isActiveHost(state.sharedHost)
    ? state.sharedHost
    : createSharedCheckerHost(onDegraded);
}

function resolveSharedCheckerHost(
  onDegraded: CheckerHostDegradationListener | undefined,
): CheckerProcessHost | undefined {
  return isHostDisabled(onDegraded)
    ? undefined
    : resolveAvailableSharedHost(onDegraded);
}

export async function runCheckerSpawnMeasured(
  spec: CheckerHostSpawnSpec,
  options: {
    onDegraded?: CheckerHostDegradationListener;
    signal?: AbortSignal;
  } = {},
): Promise<CheckerHostSpawnMeasurement> {
  const host = resolveSharedCheckerHost(options.onDegraded);

  return host
    ? host.spawnMeasured(spec, options.onDegraded, options.signal)
    : spawnAndMeasure(spec, { signal: options.signal });
}

export async function runCheckerHostProtocolProbeForTesting(options: {
  entry: { args: readonly string[]; command: string };
  onDegraded?: CheckerHostDegradationListener;
  onProtocolMessage?: (message: unknown) => void;
  spec: CheckerHostSpawnSpec;
}): Promise<CheckerHostSpawnMeasurement> {
  const child = spawn(options.entry.command, [...options.entry.args], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const host = new CheckerProcessHost(child, options.onProtocolMessage);

  try {
    return await host.spawnMeasured(options.spec, options.onDegraded);
  } finally {
    host.dispose();
    state.sharedHost = undefined;
    state.isSharedHostUnavailable = false;
    resetCheckerHostDegradationNotice();
  }
}

export function disposeCheckerProcessHostForTesting(): void {
  state.sharedHost?.dispose();
  state.sharedHost = undefined;
  state.isSharedHostUnavailable = false;
  resetCheckerHostDegradationNotice();
}
