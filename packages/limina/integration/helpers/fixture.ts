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
  if (excludedEntryNames.has(entryName)) return true;
  return entryName.endsWith('.tsbuildinfo');
}

async function copyFixtureDirectory(options: {
  destinationPath: string;
  sourcePath: string;
}): Promise<void> {
  await mkdir(options.destinationPath, { recursive: true });
  for (const entryName of await readdir(options.sourcePath)) {
    if (isExcludedEntry(entryName)) continue;
    await copyFixtureEntry(
      path.join(options.sourcePath, entryName),
      path.join(options.destinationPath, entryName),
    );
  }
}

async function copyFixtureFile(options: {
  destinationPath: string;
  mode: number;
  sourcePath: string;
}): Promise<void> {
  await mkdir(path.dirname(options.destinationPath), { recursive: true });
  await copyFile(options.sourcePath, options.destinationPath);
  await chmod(options.destinationPath, options.mode);
}

async function copyDirectoryEntryIfNeeded(options: {
  destinationPath: string;
  sourcePath: string;
  sourceStat: Awaited<ReturnType<typeof lstat>>;
}): Promise<boolean> {
  if (!options.sourceStat.isDirectory()) return false;
  await copyFixtureDirectory(options);
  return true;
}

function assertSupportedFixtureFile(options: {
  sourcePath: string;
  sourceStat: Awaited<ReturnType<typeof lstat>>;
}): void {
  if (options.sourceStat.isFile()) return;
  throw new Error(`Unsupported fixture entry: ${options.sourcePath}`);
}

async function copyFixtureEntry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Fixture symlinks are not supported: ${sourcePath}`);
  }
  const copiedDirectory = await copyDirectoryEntryIfNeeded({
    destinationPath,
    sourcePath,
    sourceStat,
  });
  if (copiedDirectory) return;
  assertSupportedFixtureFile({ sourcePath, sourceStat });
  await copyFixtureFile({
    destinationPath,
    mode: sourceStat.mode,
    sourcePath,
  });
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

function assertFixtureName(fixtureName: string): void {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fixtureName)) return;
  throw new Error(`Invalid fixture name: ${fixtureName}`);
}

async function assertFixtureSource(sourceDir: string): Promise<void> {
  const sourceStat = await lstat(sourceDir);
  if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) return;
  throw new Error(`Fixture must be a real directory: ${sourceDir}`);
}

async function createRuntimeDirectory(fixtureName: string): Promise<string> {
  const runtimeRoot = path.join(repositoryRoot, '.limina-integration');
  await mkdir(runtimeRoot, { recursive: true });
  return realpath(
    await mkdtemp(path.join(runtimeRoot, `limina-integration-${fixtureName}-`)),
  );
}

async function resolveTypeScriptBridge(options: {
  cwd: string;
  resolveFixturePath: ReturnType<typeof createFixturePathResolver>;
}): Promise<string> {
  const packageRequire = createRequire(import.meta.url);
  const installedTypescriptPackagePath = await realpath(
    packageRequire.resolve('typescript/package.json'),
  );
  await createTypeScriptDependencyBridge({
    cwd: options.cwd,
    installedTypescriptPackagePath,
  });
  const fixtureRequire = createRequire(path.join(options.cwd, 'package.json'));
  const typescriptPackagePath = await realpath(
    fixtureRequire.resolve('typescript/package.json'),
  );
  const expectedPath = await realpath(
    path.join(options.cwd, 'node_modules/typescript/package.json'),
  );
  if (typescriptPackagePath !== expectedPath) {
    throw new Error(
      `Runtime TypeScript bridge resolved unexpectedly: ${typescriptPackagePath}`,
    );
  }
  return typescriptPackagePath;
}

function createFixtureCleanup(runtimeDir: string): () => Promise<void> {
  return async () => {
    if (process.env.LIMINA_PRESERVE_INTEGRATION_ARTIFACTS === '1') return;
    await removeRuntimeDirectory(runtimeDir);
  };
}

async function prepareRuntimeFixture(options: {
  fixtureName: string;
  runtimeDir: string;
  sourceDir: string;
}): Promise<PreparedFixture> {
  await copyFixtureEntry(options.sourceDir, options.runtimeDir);
  const resolveFixturePath = createFixturePathResolver(options.runtimeDir);
  const cwd = resolveFixturePath('repo');
  const typescriptPackagePath = await resolveTypeScriptBridge({
    cwd,
    resolveFixturePath,
  });
  return {
    cleanup: createFixtureCleanup(options.runtimeDir),
    configPath: resolveFixturePath('repo/limina.config.mts'),
    cwd,
    fixtureName: options.fixtureName,
    path: resolveFixturePath,
    runtimeDir: options.runtimeDir,
    typescriptPackagePath,
  };
}

export async function prepareFixture(
  fixtureName: string,
): Promise<PreparedFixture> {
  assertFixtureName(fixtureName);
  const sourceDir = path.join(fixtureRoot, fixtureName);
  await assertFixtureSource(sourceDir);
  const runtimeDir = await createRuntimeDirectory(fixtureName);
  try {
    return await prepareRuntimeFixture({ fixtureName, runtimeDir, sourceDir });
  } catch (error) {
    await removeRuntimeDirectory(runtimeDir);
    throw error;
  }
}
