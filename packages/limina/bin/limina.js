#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distCliPath = path.join(packageDir, 'cli.js');
const sourceCliPath = path.join(packageDir, 'src/cli.ts');
const tsxBinName = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const tsxCliPath =
  [
    path.join(packageDir, 'node_modules/.bin', tsxBinName),
    path.join(packageDir, '../../node_modules/.bin', tsxBinName),
  ].find((candidate) => existsSync(candidate)) ?? 'tsx';

if (existsSync(sourceCliPath)) {
  const result = spawnSync(
    tsxCliPath,
    [sourceCliPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} else if (existsSync(distCliPath)) {
  await import(pathToFileURL(distCliPath).href);
} else {
  throw new Error(`Unable to find limina CLI entry. Expected ${distCliPath}.`);
}
