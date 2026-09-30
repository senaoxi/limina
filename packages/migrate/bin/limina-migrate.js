#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const distributionCliPath = path.join(packageDirectory, 'cli.js');
const sourceCliPath = path.join(packageDirectory, 'src/cli.ts');
const require = createRequire(import.meta.url);

if (existsSync(sourceCliPath)) {
  const tsxCliPath = require.resolve('tsx/cli');
  const result = spawnSync(
    process.execPath,
    [
      tsxCliPath,
      '--conditions=development',
      sourceCliPath,
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}
if (existsSync(distributionCliPath)) {
  const { runCli } = await import(pathToFileURL(distributionCliPath).href);
  await runCli(process.argv);
} else {
  throw new Error(
    `Unable to find limina-migrate CLI entry. Expected ${distributionCliPath}.`,
  );
}
