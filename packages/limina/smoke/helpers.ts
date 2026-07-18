import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env as inheritedEnvironment } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface CommandResult {
  code?: string;
  exitCode: number;
  failed: boolean;
  stderr: string;
  stdout: string;
}

export interface ConsumerFixture {
  cleanup: () => Promise<void>;
  configPath: string;
  fixtureDir: string;
}

export interface DistPackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  name: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  types?: string;
}

interface PackedDistTarball {
  cleanup: () => Promise<void>;
  tarballPath: string;
}

export const PACKAGE_ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DIST_DIR = path.join(PACKAGE_ROOT_DIR, 'dist');
export const RELEASE_FIXTURE_PACKAGE_NAME = '@limina-smoke/release-fixture';
const REQUIRED_DIST_FILES = [
  'package.json',
  'bin/limina.js',
  'cli.js',
  'index.js',
  'index.d.ts',
  'schemas/tsconfig-schema.json',
] as const;

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function getPnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function resolvePnpmCommand(environment: NodeJS.ProcessEnv): {
  command: string;
  argsPrefix: string[];
} {
  const npmExecPath = environment.npm_execpath;
  const npmExecFileName = npmExecPath
    ? path.basename(npmExecPath).toLowerCase()
    : undefined;

  // Package scripts expose the exact pnpm JS entry that launched them. Running
  // that entry through Node avoids an extra cmd.exe/.cmd parsing round-trip on
  // Windows, where shell metacharacters in forwarded CLI arguments can change.
  if (
    npmExecPath &&
    existsSync(npmExecPath) &&
    (npmExecFileName === 'pnpm.cjs' ||
      npmExecFileName === 'pnpm.mjs' ||
      npmExecFileName === 'pnpm.js')
  ) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
    };
  }

  // Corepack sets COREPACK_ROOT before handing off to pnpm. Nx preserves that
  // environment for inferred package-script targets even when npm_execpath is
  // absent, so invoke the same Corepack entry without crossing its .cmd shim.
  const corepackPnpmPath = environment.COREPACK_ROOT
    ? path.join(environment.COREPACK_ROOT, 'dist', 'pnpm.js')
    : undefined;

  if (corepackPnpmPath && existsSync(corepackPnpmPath)) {
    return {
      command: process.execPath,
      argsPrefix: [corepackPnpmPath],
    };
  }

  return {
    command: getPnpmCommand(),
    argsPrefix: [],
  };
}

function getNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as T;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
    reject?: boolean;
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  },
): Promise<CommandResult> {
  const result = await execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    reject: options.reject ?? true,
    stderr: options.inherit ? 'inherit' : 'pipe',
    stdin: 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout ?? 120_000,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });

  return {
    code: result.code,
    exitCode: result.exitCode ?? 1,
    failed: result.failed,
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

export async function runPnpm(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
    reject?: boolean;
    timeout?: number;
  },
): Promise<CommandResult> {
  const { command, argsPrefix } = resolvePnpmCommand({
    ...inheritedEnvironment,
    ...options.env,
  });

  return runCommand(command, [...argsPrefix, ...args], options);
}

export async function runNodeScript(options: {
  cwd: string;
  scriptPath: string;
}): Promise<CommandResult> {
  return runCommand(process.execPath, [options.scriptPath], {
    cwd: options.cwd,
  });
}

export function getPeerDependencyRange(
  manifest: DistPackageJson,
  packageName: string,
): string {
  const range = manifest.peerDependencies?.[packageName];

  if (!range) {
    throw new Error(
      `Expected dist package.json to declare peerDependencies.${packageName}.`,
    );
  }

  return range;
}

export function readDistManifest(): DistPackageJson {
  const manifestPath = path.join(DIST_DIR, 'package.json');

  if (!existsSync(manifestPath)) {
    throw new Error(
      `Expected dist package manifest at ${manifestPath}. Run pnpm nx run limina:build first.`,
    );
  }

  return readJsonFile<DistPackageJson>(manifestPath);
}

export function assertDistArtifacts(): DistPackageJson {
  const manifest = readDistManifest();

  for (const relativeFilePath of REQUIRED_DIST_FILES) {
    const filePath = path.join(DIST_DIR, relativeFilePath);

    if (!existsSync(filePath)) {
      throw new Error(
        `Expected limina dist artifact at ${filePath}. Run pnpm nx run limina:build first.`,
      );
    }
  }

  if (manifest.name !== 'limina') {
    throw new Error(
      `Expected dist package name "limina", got ${manifest.name}`,
    );
  }

  if (manifest.bin?.limina !== './bin/limina.js') {
    throw new Error('Expected dist package.json to expose bin.limina.');
  }

  if (manifest.types !== './index.d.ts') {
    throw new Error('Expected dist package.json to expose ./index.d.ts.');
  }

  if (
    manifest.peerDependenciesMeta?.['npm-package-json-lint']?.optional !== true
  ) {
    throw new Error(
      'Expected dist package.json to mark npm-package-json-lint as an optional peer dependency.',
    );
  }

  return manifest;
}

export async function packLiminaDist(): Promise<PackedDistTarball> {
  const destination = await mkdtemp(path.join(tmpdir(), 'limina-package-'));

  try {
    const result = await execa(
      getNpmCommand(),
      ['pack', DIST_DIR, '--pack-destination', destination, '--ignore-scripts'],
      {
        maxBuffer: 64 * 1024 * 1024,
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'pipe',
        timeout: 120_000,
      },
    );
    const fileName = result.stdout.trim().split(/\r?\n/u).at(-1);

    if (!fileName) {
      throw new Error(`npm pack did not report a tarball for ${DIST_DIR}`);
    }

    return {
      cleanup: async () => {
        await rm(destination, {
          force: true,
          recursive: true,
        });
      },
      tarballPath: path.join(destination, fileName),
    };
  } catch (error) {
    await rm(destination, {
      force: true,
      recursive: true,
    });
    throw error;
  }
}

export async function readCurrentPnpmConfig<T>(
  key: string,
): Promise<T | undefined> {
  try {
    const result = await execa(
      getPnpmCommand(),
      ['config', 'get', key, '--json'],
      {
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
        timeout: 30_000,
      },
    );
    const rawValue = result.stdout.trim();

    if (
      rawValue.length === 0 ||
      rawValue === 'undefined' ||
      rawValue === 'null'
    ) {
      return undefined;
    }

    return JSON.parse(rawValue) as T;
  } catch {
    return undefined;
  }
}

async function writeConsumerPackageManagerConfig(
  fixtureDir: string,
): Promise<void> {
  const trustPolicy = await readCurrentPnpmConfig<string>('trust-policy');
  const trustPolicyExcludes =
    (await readCurrentPnpmConfig<string[]>('trust-policy-exclude')) ?? [];
  const lines: string[] = [
    'auto-install-peers=false',
    'strict-peer-dependencies=true',
  ];

  if (trustPolicy) {
    lines.push(`trust-policy=${trustPolicy}`);
  }

  for (const exclude of trustPolicyExcludes) {
    lines.push(`trust-policy-exclude[]=${exclude}`);
  }

  if (lines.length === 0) {
    return;
  }

  await writeFile(
    path.join(fixtureDir, '.npmrc'),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

async function writeConsumerFiles(
  fixtureDir: string,
  configFileName: string,
): Promise<void> {
  const pnpmVersionResult = await runPnpm(['--version'], {
    cwd: fixtureDir,
    timeout: 30_000,
  });
  const pnpmVersion = pnpmVersionResult.stdout.trim();

  await mkdir(path.join(fixtureDir, 'app', 'src'), { recursive: true });
  await mkdir(path.join(fixtureDir, 'release-dist'), { recursive: true });

  await writeFile(
    path.join(fixtureDir, 'package.json'),
    stringifyJson({
      name: 'limina-consumer-smoke',
      packageManager: `pnpm@${pnpmVersion}`,
      private: true,
      type: 'module',
    }),
    'utf8',
  );

  await writeConsumerPackageManagerConfig(fixtureDir);

  await writeFile(
    path.join(fixtureDir, 'pnpm-workspace.yaml'),
    'packages:\n  - app\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, configFileName),
    `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['app/tsconfig.json'],
      },
    },
    source: {
      include: ['**/*.ts'],
      exclude: ['node_modules', '.limina', '.tsbuild', 'dist'],
    },
  },
  package: {
    entries: [
      {
        name: '${RELEASE_FIXTURE_PACKAGE_NAME}',
        outDir: 'release-dist',
      },
    ],
  },
});
`,
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'app', 'package.json'),
    stringifyJson({
      name: '@limina-smoke/app',
      type: 'module',
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'app', 'src', 'index.ts'),
    'export const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'app', 'tsconfig.json'),
    stringifyJson({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'app', 'tsconfig.lib.json'),
    stringifyJson({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        noEmit: true,
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'release-dist', 'package.json'),
    stringifyJson({
      exports: {
        '.': './index.js',
      },
      license: 'MIT',
      name: RELEASE_FIXTURE_PACKAGE_NAME,
      type: 'module',
      types: './index.d.ts',
      version: '1.0.0',
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'release-dist', 'index.js'),
    'export const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'release-dist', 'index.d.ts'),
    'export declare const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'release-dist', 'README.md'),
    '# Release fixture\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'release-dist', 'LICENSE.md'),
    'MIT\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDir, 'verify-exports.mjs'),
    `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicApi = await import('limina');
const schemaPath = fileURLToPath(import.meta.resolve('limina/schemas/tsconfig-schema.json'));
const packageJsonPath = fileURLToPath(import.meta.resolve('limina/package.json'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

if (typeof publicApi.defineConfig !== 'function') {
  throw new Error('limina root export did not expose defineConfig.');
}
for (const removedExport of [
  'loadConfig',
  'runGraphCheck',
  'runSourceCheck',
  'prepareGeneratedTsconfigGraph',
  'collectDependencyGraph',
  'createLiminaFlowReporter',
]) {
  if (removedExport in publicApi) {
    throw new Error(\`limina root export should not expose \${removedExport}.\`);
  }
}
let configExportRejected = false;
try {
  await import('limina/config');
} catch (error) {
  configExportRejected =
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}
if (!configExportRejected) {
  throw new Error('limina/config export should not be exposed.');
}
if (manifest.name !== 'limina') {
  throw new Error('limina/package.json did not resolve to the installed package.');
}
if (!schema || typeof schema !== 'object') {
  throw new Error('limina schema export did not resolve to JSON content.');
}

console.log('limina exports ok');
`,
    'utf8',
  );
}

export async function installConsumerDependencies(options: {
  fixtureDir: string;
  manifest: DistPackageJson;
  tarballPath: string;
}): Promise<void> {
  const typescriptRange = getPeerDependencyRange(
    options.manifest,
    'typescript',
  );
  const knipRange = getPeerDependencyRange(options.manifest, 'knip');

  await runPnpm(
    [
      'add',
      '--save-dev',
      '--prefer-offline',
      '--ignore-scripts',
      options.tarballPath,
      `typescript@${typescriptRange}`,
      `knip@${knipRange}`,
    ],
    {
      cwd: options.fixtureDir,
      inherit: true,
      timeout: 300_000,
    },
  );
}

export async function createConsumerFixture(options: {
  configFileName?: string;
  directoryName?: string;
  manifest: DistPackageJson;
  sourceText?: string;
  tarballPath: string;
}): Promise<ConsumerFixture> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'limina-smoke-'));
  const configFileName = options.configFileName ?? 'limina.config.mjs';
  const fixtureDir = path.join(fixtureRoot, options.directoryName ?? 'fixture');

  try {
    await mkdir(fixtureDir, {
      recursive: true,
    });
    await writeConsumerFiles(fixtureDir, configFileName);
    if (options.sourceText !== undefined) {
      await writeFile(
        path.join(fixtureDir, 'app', 'src', 'index.ts'),
        options.sourceText,
        'utf8',
      );
    }
    await installConsumerDependencies({
      fixtureDir,
      manifest: options.manifest,
      tarballPath: options.tarballPath,
    });

    return {
      cleanup: async () => {
        await rm(fixtureRoot, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 100,
        });
      },
      configPath: path.join(fixtureDir, configFileName),
      fixtureDir,
    };
  } catch (error) {
    await rm(fixtureRoot, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
    throw error;
  }
}
