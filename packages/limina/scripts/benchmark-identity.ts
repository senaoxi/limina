import process from 'node:process';
import path from 'pathe';
import {
  collectBuildInputIdentity,
  collectLinkedRuntimeTreeIdentity,
} from '../src/profiling/identity';

async function main(): Promise<void> {
  const action = process.argv[2];
  const targetRoot = path.resolve(process.argv[3] ?? process.cwd());
  const identity =
    action === 'build-input'
      ? await collectBuildInputIdentity(targetRoot)
      : action === 'runtime'
        ? await collectLinkedRuntimeTreeIdentity(targetRoot)
        : undefined;

  if (!identity) {
    throw new Error(
      'Usage: benchmark-identity.ts <build-input|runtime> [root-directory]',
    );
  }

  process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
}

await main();
