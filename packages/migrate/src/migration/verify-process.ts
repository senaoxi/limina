import { loadConfig, readInputTopology } from 'limina/internal/migration';
import { assertRuntimeVersion } from '../runtime-version';

function loaderName(value: string | undefined): 'native' | 'tsx' {
  if (value === 'native') return value;
  if (value === 'tsx') return value;
  throw new Error('Invalid migration verification loader.');
}

async function main(): Promise<void> {
  assertRuntimeVersion();
  const [configPath, loader, mode] = process.argv.slice(2);
  if (!configPath) throw new Error('Missing migration verification config.');
  const configLoader = loaderName(loader);
  const results = [];
  for (const command of ['check', 'graph']) {
    const config = await loadConfig({
      command,
      configPath,
      configLoader,
      mode,
    });
    const topology = await readInputTopology(config);
    delete topology.workspace;
    results.push({ command, ...topology });
  }
  process.stdout.write(`\nLIMINA_MIGRATION_INPUT=${JSON.stringify(results)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
