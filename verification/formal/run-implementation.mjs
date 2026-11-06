import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export function runImplementationReplay(name) {
  const script = new URL(
    `../../packages/limina/integration/formal/${name}.mjs`,
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(script), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status;
}
