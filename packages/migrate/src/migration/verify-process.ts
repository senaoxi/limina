import { loadConfig } from 'limina/internal/config/runner';
import { readInputTopology } from 'limina/internal/core/build-graph/input-topology';
import { assertRuntimeVersion } from '../runtime-version';

function loaderName(value: string | undefined): 'native' | 'tsx' {
  if (value === 'native') return value;
  if (value === 'tsx') return value;
  throw new Error('Invalid migration verification loader.');
}
function commandName(value: string | undefined): 'check' | 'graph' {
  if (value === 'check') return value;
  if (value === 'graph') return value;
  throw new Error('Invalid migration verification command.');
}

async function main(): Promise<void> {
  assertRuntimeVersion();
  const [configPath, loader, mode, requestedCommand] = process.argv.slice(2);
  if (!configPath) throw new Error('Missing migration verification config.');
  const configLoader = loaderName(loader);
  const command = commandName(requestedCommand);
  const config = await loadConfig({ command, configPath, configLoader, mode });
  const topology = await readInputTopology(config);
  delete topology.workspace;
  const results = [{ command, ...topology }];
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
