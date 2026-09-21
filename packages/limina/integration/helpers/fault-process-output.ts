import type { ChildProcess } from 'node:child_process';

/** Observe each complete stdout/stderr line pair from fault-process-helper. */
export function observeFaultProcessOutput(
  child: Pick<ChildProcess, 'stdout' | 'stderr'>,
  onOutput: () => void,
): void {
  const lines = { stderr: 0, stdout: 0 };
  let observedPairs = 0;

  function observeStream(name: 'stdout' | 'stderr'): void {
    child[name]?.on('data', (chunk: Uint8Array) => {
      // Pipe chunks can split or combine writes. The controlled helper emits
      // newline-terminated records, so occurrences must count complete lines.
      for (const byte of chunk) {
        if (byte === 10) lines[name] += 1;
      }

      const completePairs = Math.min(lines.stdout, lines.stderr);
      while (observedPairs < completePairs) {
        observedPairs += 1;
        // A stream error kills the child. Wait for both streams and let the
        // command runner's remaining data listeners forward this chunk first.
        queueMicrotask(onOutput);
      }
    });
  }

  observeStream('stdout');
  observeStream('stderr');
}
