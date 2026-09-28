import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isPathInsideDirectory } from '../../src/utils/path';
import type { FixtureToolName } from './detector-fixture-types';

export interface FixtureToolBridgeResult {
  readonly binDirectory: string;
  readonly bridgedTools: readonly FixtureToolName[];
  readonly packageManifestPaths: ReadonlyMap<FixtureToolName, string>;
}

interface CreateFixtureToolBridgesOptions {
  readonly fixtureId: string;
  readonly repoRoot: string;
  readonly resolvePackageJson?: (packageName: string) => string;
  readonly tools: readonly FixtureToolName[];
}

type PackageJsonResolver = (packageName: string) => string;

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createTypeScriptBridge(options: {
  readonly binDirectory: string;
  readonly fixtureId: string;
  readonly packageJsonPath: string;
  readonly repoRoot: string;
}): Promise<string> {
  const installedPackageJson = await realpath(options.packageJsonPath);
  const installedPackageRoot = path.dirname(installedPackageJson);
  const compilerPath = path.join(installedPackageRoot, 'bin/tsc');
  const compilerStat = await lstat(compilerPath);
  if (!compilerStat.isFile() || compilerStat.isSymbolicLink()) {
    throw new Error(
      `Detector fixture ${options.fixtureId} resolved TypeScript compiler is not a real file: ${compilerPath}`,
    );
  }
  const bridgePackageRoot = path.join(
    options.repoRoot,
    'node_modules/typescript',
  );
  const bridgePackageJson = path.join(bridgePackageRoot, 'package.json');
  await mkdir(bridgePackageRoot, { recursive: true });
  await copyFile(installedPackageJson, bridgePackageJson);
  await mkdir(options.binDirectory, { recursive: true });
  const posixShimPath = path.join(options.binDirectory, 'tsc');
  await writeFile(
    posixShimPath,
    [
      '#!/usr/bin/env sh',
      `exec ${quotePosixArgument(process.execPath)} ${quotePosixArgument(compilerPath)} "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(posixShimPath, 0o755);
  await writeFile(
    path.join(options.binDirectory, 'tsc.cmd'),
    [
      '@ECHO OFF',
      `${quoteCmdArgument(process.execPath)} ${quoteCmdArgument(compilerPath)} %*`,
      '',
    ].join('\r\n'),
    'utf8',
  );
  return bridgePackageJson;
}

async function createCommonJsPackageBridge(options: {
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly repoRoot: string;
}): Promise<string> {
  const installedPackageJson = await realpath(options.packageJsonPath);
  const installedPackageRoot = path.dirname(installedPackageJson);
  const bridgePackageRoot = path.join(
    options.repoRoot,
    'node_modules',
    options.packageName,
  );
  const bridgePackageJson = path.join(bridgePackageRoot, 'package.json');
  await mkdir(bridgePackageRoot, { recursive: true });
  await writeFile(
    bridgePackageJson,
    `${JSON.stringify(
      { main: './index.cjs', name: options.packageName, private: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    path.join(bridgePackageRoot, 'index.cjs'),
    `module.exports = require(${JSON.stringify(installedPackageRoot)});\n`,
    'utf8',
  );
  return bridgePackageJson;
}

function assertBridgeRoot(
  repoRoot: string,
  binDirectory: string,
  fixtureId: string,
): void {
  if (isPathInsideDirectory(binDirectory, repoRoot)) return;
  throw new Error(
    `Detector fixture ${fixtureId} tool bridge escaped the sandbox: ${binDirectory}`,
  );
}

function createPackageJsonResolver(
  resolver: PackageJsonResolver | undefined,
): PackageJsonResolver {
  if (resolver !== undefined) return resolver;
  const requireFromHarness = createRequire(import.meta.url);
  return (packageName) =>
    requireFromHarness.resolve(`${packageName}/package.json`);
}

function assertSupportedTool(tool: FixtureToolName, fixtureId: string): void {
  if (tool === 'typescript') return;
  if (tool === 'npm-package-json-lint') return;
  throw new Error(
    `Detector fixture ${fixtureId} requested unsupported tool bridge ${tool}. Only typescript and npm-package-json-lint are implemented in harness v2.`,
  );
}

function resolveToolPackageJson(options: {
  fixtureId: string;
  resolvePackageJson: PackageJsonResolver;
  tool: FixtureToolName;
}): string {
  try {
    return options.resolvePackageJson(options.tool);
  } catch (error) {
    throw new Error(
      `Detector fixture ${options.fixtureId} could not resolve tool ${options.tool} from the Limina development workspace: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }
}

async function createToolBridge(options: {
  binDirectory: string;
  fixtureId: string;
  packageJsonPath: string;
  repoRoot: string;
  tool: FixtureToolName;
}): Promise<string> {
  if (options.tool === 'typescript') {
    return createTypeScriptBridge(options);
  }
  return createCommonJsPackageBridge({
    packageJsonPath: options.packageJsonPath,
    packageName: options.tool,
    repoRoot: options.repoRoot,
  });
}

async function verifyToolBridge(options: {
  bridgePackageJson: string;
  repoRoot: string;
  tool: FixtureToolName;
  fixtureId: string;
}): Promise<void> {
  const fixtureRequire = createRequire(
    path.join(options.repoRoot, 'package.json'),
  );
  const resolvedPackageJson = await realpath(
    fixtureRequire.resolve(`${options.tool}/package.json`),
  );
  const expectedPackageJson = await realpath(options.bridgePackageJson);
  if (resolvedPackageJson === expectedPackageJson) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} tool ${options.tool} resolved outside its sandbox bridge: ${resolvedPackageJson}`,
  );
}

async function createToolBridges(options: {
  binDirectory: string;
  fixtureId: string;
  repoRoot: string;
  resolvePackageJson: PackageJsonResolver;
  tools: readonly FixtureToolName[];
}): Promise<Map<FixtureToolName, string>> {
  const packageManifestPaths = new Map<FixtureToolName, string>();
  for (const tool of options.tools) {
    assertSupportedTool(tool, options.fixtureId);
    const packageJsonPath = resolveToolPackageJson({
      fixtureId: options.fixtureId,
      resolvePackageJson: options.resolvePackageJson,
      tool,
    });
    packageManifestPaths.set(
      tool,
      await createToolBridge({ ...options, packageJsonPath, tool }),
    );
  }
  return packageManifestPaths;
}

async function verifyToolBridges(options: {
  fixtureId: string;
  packageManifestPaths: ReadonlyMap<FixtureToolName, string>;
  repoRoot: string;
}): Promise<void> {
  for (const [tool, bridgePackageJson] of options.packageManifestPaths) {
    await verifyToolBridge({ ...options, bridgePackageJson, tool });
  }
}

export async function createFixtureToolBridges(
  options: CreateFixtureToolBridgesOptions,
): Promise<FixtureToolBridgeResult> {
  const repoRoot = await realpath(options.repoRoot);
  const binDirectory = path.join(repoRoot, 'node_modules/.bin');
  assertBridgeRoot(repoRoot, binDirectory, options.fixtureId);
  const packageManifestPaths = await createToolBridges({
    binDirectory,
    fixtureId: options.fixtureId,
    repoRoot,
    resolvePackageJson: createPackageJsonResolver(options.resolvePackageJson),
    tools: options.tools,
  });
  await verifyToolBridges({
    fixtureId: options.fixtureId,
    packageManifestPaths,
    repoRoot,
  });
  return {
    binDirectory,
    bridgedTools: [...options.tools],
    packageManifestPaths,
  };
}
