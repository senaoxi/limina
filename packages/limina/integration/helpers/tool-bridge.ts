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
      {
        main: './index.cjs',
        name: options.packageName,
        private: true,
      },
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

export async function createFixtureToolBridges(
  options: CreateFixtureToolBridgesOptions,
): Promise<FixtureToolBridgeResult> {
  const repoRoot = await realpath(options.repoRoot);
  const binDirectory = path.join(repoRoot, 'node_modules/.bin');
  if (!isPathInsideDirectory(binDirectory, repoRoot)) {
    throw new Error(
      `Detector fixture ${options.fixtureId} tool bridge escaped the sandbox: ${binDirectory}`,
    );
  }
  const requireFromHarness = createRequire(import.meta.url);
  const resolvePackageJson =
    options.resolvePackageJson ??
    ((packageName: string) =>
      requireFromHarness.resolve(`${packageName}/package.json`));
  const packageManifestPaths = new Map<FixtureToolName, string>();

  for (const tool of options.tools) {
    if (tool !== 'typescript' && tool !== 'npm-package-json-lint') {
      throw new Error(
        `Detector fixture ${options.fixtureId} requested unsupported tool bridge ${tool}. Only typescript and npm-package-json-lint are implemented in harness v2.`,
      );
    }

    let packageJsonPath: string;
    try {
      packageJsonPath = resolvePackageJson(tool);
    } catch (error) {
      throw new Error(
        `Detector fixture ${options.fixtureId} could not resolve tool ${tool} from the Limina development workspace: ${formatUnknownError(error)}`,
        { cause: error },
      );
    }

    const bridgePackageJson =
      tool === 'typescript'
        ? await createTypeScriptBridge({
            binDirectory,
            fixtureId: options.fixtureId,
            packageJsonPath,
            repoRoot,
          })
        : await createCommonJsPackageBridge({
            packageJsonPath,
            packageName: tool,
            repoRoot,
          });
    packageManifestPaths.set(tool, bridgePackageJson);
  }

  for (const [tool, bridgePackageJson] of packageManifestPaths) {
    const fixtureRequire = createRequire(path.join(repoRoot, 'package.json'));
    const resolvedPackageJson = await realpath(
      fixtureRequire.resolve(`${tool}/package.json`),
    );
    const expectedPackageJson = await realpath(bridgePackageJson);
    if (resolvedPackageJson !== expectedPackageJson) {
      throw new Error(
        `Detector fixture ${options.fixtureId} tool ${tool} resolved outside its sandbox bridge: ${resolvedPackageJson}`,
      );
    }
  }

  return {
    binDirectory,
    bridgedTools: [...options.tools],
    packageManifestPaths,
  };
}
