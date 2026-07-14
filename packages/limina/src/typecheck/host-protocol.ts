import { type ChildProcess, spawn } from 'node:child_process';

export interface CheckerHostSpawnSpec {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  shell: boolean;
  stdio: 'ignore' | 'inherit';
}

export interface CheckerHostSpawnMeasurement {
  durationMs: number;
  error?: Error;
  status: number;
}

export type CheckerHostRequest =
  | (CheckerHostSpawnSpec & {
      id: number;
      type: 'spawn';
    })
  | { type: 'ping' };

export type CheckerHostResponse =
  | { type: 'ready' }
  | {
      durationMs: number;
      errorMessage?: string;
      id: number;
      status: number;
      type: 'result';
    };

/**
 * Spawns one checker command and measures its lifetime from spawn until the
 * close/error event. The measurement is only accurate when the surrounding
 * event loop stays responsive while the child runs, so the checker host
 * process is the primary caller; the parent CLI process uses it directly only
 * as the degraded in-process fallback.
 */
export function spawnAndMeasure(
  spec: CheckerHostSpawnSpec,
  options: { onChild?: (child: ChildProcess) => void } = {},
): Promise<CheckerHostSpawnMeasurement> {
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = performance.now();
    const finalize = (measurement: CheckerHostSpawnMeasurement): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(measurement);
    };

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      stdio: spec.stdio,
    });

    options.onChild?.(child);

    child.on('error', (error) => {
      finalize({
        durationMs: performance.now() - startedAt,
        error,
        status: 1,
      });
    });

    child.on('close', (code) => {
      finalize({
        durationMs: performance.now() - startedAt,
        status: code ?? 1,
      });
    });
  });
}
