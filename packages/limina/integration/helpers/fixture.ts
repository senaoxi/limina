import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixturePathResolver } from '../../src/__tests__/helpers/path';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const excludedEntryNames = new Set([
  '.limina',
  'coverage',
  'dist',
  'node_modules',
]);

export interface PreparedFixture {
  cleanup: () => Promise<void>;
  configPath: string;
  cwd: string;
  fixtureName: string;
  path: (...segments: string[]) => string;
  runtimeDir: string;
  typescriptPackagePath: string;
}

function isExcludedEntry(entryName: string): boolean {
  return (
    excludedEntryNames.has(entryName) || entryName.endsWith('.tsbuildinfo')
  );
}

async function copyFixtureEntry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath);

  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Fixture symlinks are not supported: ${sourcePath}`);
  }

  if (sourceStat.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });

    for (const entryName of await readdir(sourcePath)) {
      if (isExcludedEntry(entryName)) {
        continue;
      }

      await copyFixtureEntry(
        path.join(sourcePath, entryName),
        path.join(destinationPath, entryName),
      );
    }

    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported fixture entry: ${sourcePath}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, sourceStat.mode);
}

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

async function createTypeScriptDependencyBridge(options: {
  cwd: string;
  installedTypescriptPackagePath: string;
}): Promise<void> {
  const binDirectory = path.join(options.cwd, 'node_modules/.bin');
  const tscPath = path.join(
    path.dirname(options.installedTypescriptPackagePath),
    'bin/tsc',
  );

  if (!(await lstat(tscPath)).isFile()) {
    throw new Error(`Resolved TypeScript compiler is not a file: ${tscPath}`);
  }

  await mkdir(path.join(options.cwd, 'node_modules/typescript'), {
    recursive: true,
  });
  await copyFile(
    options.installedTypescriptPackagePath,
    path.join(options.cwd, 'node_modules/typescript/package.json'),
  );
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    path.join(binDirectory, 'tsc'),
    [
      '#!/usr/bin/env sh',
      `exec ${quotePosixArgument(process.execPath)} ${quotePosixArgument(tscPath)} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(binDirectory, 'tsc'), 0o755);
  await writeFile(
    path.join(binDirectory, 'tsc.cmd'),
    [
      '@ECHO OFF',
      `${quoteCmdArgument(process.execPath)} ${quoteCmdArgument(tscPath)} %*`,
      '',
    ].join('\r\n'),
  );
}

async function removeRuntimeDirectory(runtimeDir: string): Promise<void> {
  await rm(runtimeDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

export async function prepareFixture(
  fixtureName: string,
): Promise<PreparedFixture> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fixtureName)) {
    throw new Error(`Invalid fixture name: ${fixtureName}`);
  }

  const sourceDir = path.join(fixtureRoot, fixtureName);
  const sourceStat = await lstat(sourceDir);

  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Fixture must be a real directory: ${sourceDir}`);
  }

  const runtimeRoot = path.join(repositoryRoot, '.limina-integration');
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeDir = await realpath(
    await mkdtemp(path.join(runtimeRoot, `limina-integration-${fixtureName}-`)),
  );

  try {
    await copyFixtureEntry(sourceDir, runtimeDir);

    const resolveFixturePath = createFixturePathResolver(runtimeDir);
    const cwd = resolveFixturePath('repo');
    const packageRequire = createRequire(import.meta.url);
    const installedTypescriptPackagePath = await realpath(
      packageRequire.resolve('typescript/package.json'),
    );

    await createTypeScriptDependencyBridge({
      cwd,
      installedTypescriptPackagePath,
    });

    const fixtureRequire = createRequire(path.join(cwd, 'package.json'));
    const typescriptPackagePath = await realpath(
      fixtureRequire.resolve('typescript/package.json'),
    );
    const expectedTypescriptPackagePath = await realpath(
      path.join(cwd, 'node_modules/typescript/package.json'),
    );

    if (typescriptPackagePath !== expectedTypescriptPackagePath) {
      throw new Error(
        `Runtime TypeScript bridge resolved unexpectedly: ${typescriptPackagePath}`,
      );
    }

    return {
      cleanup: async () => {
        if (process.env.LIMINA_PRESERVE_INTEGRATION_ARTIFACTS !== '1') {
          await removeRuntimeDirectory(runtimeDir);
        }
      },
      configPath: resolveFixturePath('repo/limina.config.mts'),
      cwd,
      fixtureName,
      path: resolveFixturePath,
      runtimeDir,
      typescriptPackagePath,
    };
  } catch (error) {
    await removeRuntimeDirectory(runtimeDir);
    throw error;
  }
}
