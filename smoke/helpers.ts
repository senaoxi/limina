import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env as inheritedEnvironment } from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

interface AstroConsumerToolchain {
  checkVersion: string;
  typeScriptVersion: string;
}

export interface DistributionPackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  types?: string;
}

interface PackedDistributionTarball {
  cleanup: () => Promise<void>;
  tarballPath: string;
}

export async function assertPackageModuleClosure(
  root: string,
  manifest: DistributionPackageJson,
): Promise<void> {
  const allowed = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const developmentTypes = new Set(Object.keys(manifest.devDependencies ?? {}));
  const files = await readdir(root, { recursive: true });
  const imports = new Map<string, string[]>();
  for (const file of files) {
    if (!/\.(?:js|d\.ts)$/u.test(file)) continue;
    const filePath = path.join(root, file);
    const text = await readFile(filePath, 'utf8');
    const syntax = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifiers.push(node.arguments[0].text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifiers.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    imports.set(file, specifiers);
  }
  const publicDeclarations = new Set<string>();
  const pendingDeclarations: string[] = [];
  const addPublicEntry = (value: unknown): void => {
    if (typeof value === 'string') {
      const declaration = value.replace(/\.js$/u, '.d.ts');
      const file = path.relative(root, path.resolve(root, declaration));
      if (file.endsWith('.d.ts') && imports.has(file))
        pendingDeclarations.push(file);
    } else if (value && typeof value === 'object')
      for (const entry of Object.values(value)) addPublicEntry(entry);
  };
  addPublicEntry(manifest.types);
  addPublicEntry(manifest.exports);
  while (pendingDeclarations.length > 0) {
    const file = pendingDeclarations.pop()!;
    if (publicDeclarations.has(file)) continue;
    publicDeclarations.add(file);
    const specifiers = imports.get(file) ?? [];
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const target = path.relative(
        root,
        path
          .resolve(root, path.dirname(file), specifier)
          .replace(/\.js$/u, '.d.ts'),
      );
      if (imports.has(target)) pendingDeclarations.push(target);
    }
  }
  for (const [file, specifiers] of imports) {
    const filePath = path.join(root, file);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filePath), specifier);
        const declaration = file.endsWith('.d.ts')
          ? target.replace(/\.js$/u, '.d.ts')
          : target;
        await access(existsSync(target) ? target : declaration);
      } else if (!specifier.startsWith('node:')) {
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/', 1)[0]!;
        if (
          specifier.startsWith('#') ||
          name.startsWith('@limina/') ||
          specifier.startsWith('limina/internal/') ||
          (!allowed.has(name) &&
            // The retained, unexported workspace support declaration can
            // describe build-time types. Public declarations and runtime JS
            // must be consumable without development dependencies.
            !(
              file.endsWith('.d.ts') &&
              !publicDeclarations.has(file) &&
              developmentTypes.has(name)
            ))
        ) {
          throw new Error(
            `Undeclared or workspace-only published import in ${file}: ${specifier}`,
          );
        }
      }
    }
  }
}

export const PACKAGE_ROOT_DIR = fileURLToPath(
  new URL('../packages/limina/', import.meta.url),
);
export const DIST_DIR = path.join(PACKAGE_ROOT_DIR, 'dist');
export const RELEASE_FIXTURE_PACKAGE_NAME = '@limina-smoke/release-fixture';
const REQUIRED_DIST_FILES = [
  'package.json',
  'bin/limina.js',
  'cli.js',
  'checker-host-process.js',
  'flow-renderer-process.js',
  'LICENSE.md',
  'index.js',
  'index.d.ts',
  'schemas/tsconfig-schema.json',
] as const;
const EXPECTED_PEER_RANGES = {
  '@arethetypeswrong/core': '^0.18.3',
  '@astrojs/check': '>=0.9.6 <0.10.0',
  '@typescript/native-preview': '>=7.0.0-dev.20260421.2 <7.0.0',
  knip: '>=6.0.0 <7.0.0',
  'npm-package-json-lint': '>=9.1.0 <10.0.0',
  publint: '>=0.3.0 <0.4.0',
  svelte2tsx: '^0.7.61',
  'svelte-check': '>=4.0.0 <5.0.0',
  tsx: '^4.9.0',
  typescript: '>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0',
  'vue-tsc': '>=2.2.0 <=2.2.12 || >=3.2.0 <=3.2.4',
} as const;
const CHECKER_INTERNAL_PACKAGES = [
  '@volar/typescript',
  '@vue/language-core',
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
    ['pnpm.cjs', 'pnpm.mjs', 'pnpm.js'].includes(npmExecFileName ?? '')
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
  return JSON.parse(
    readFileSync(filePath, 'utf8').replace(/^\u{FEFF}/u, ''),
  ) as T;
}

export async function runCommand(
  command: string,
  arguments_: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
    reject?: boolean;
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  },
): Promise<CommandResult> {
  const result = await execa(command, arguments_, {
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
  arguments_: string[],
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

  return runCommand(command, [...argsPrefix, ...arguments_], options);
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
  manifest: DistributionPackageJson,
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

export function readDistributionManifest(): DistributionPackageJson {
  const manifestPath = path.join(DIST_DIR, 'package.json');

  if (!existsSync(manifestPath)) {
    throw new Error(
      `Expected dist package manifest at ${manifestPath}. Run pnpm run build first.`,
    );
  }

  return readJsonFile<DistributionPackageJson>(manifestPath);
}

export function assertDistributionArtifacts(): DistributionPackageJson {
  const manifest = readDistributionManifest();

  for (const relativeFilePath of REQUIRED_DIST_FILES) {
    const filePath = path.join(DIST_DIR, relativeFilePath);

    if (!existsSync(filePath)) {
      throw new Error(
        `Expected limina dist artifact at ${filePath}. Run pnpm run build first.`,
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

  const expectedPeerNames = Object.keys(EXPECTED_PEER_RANGES).toSorted(
    (left, right) => Number(left > right) - Number(left < right),
  );
  const actualPeerNames = Object.keys(manifest.peerDependencies ?? {}).toSorted(
    (left, right) => Number(left > right) - Number(left < right),
  );
  if (JSON.stringify(actualPeerNames) !== JSON.stringify(expectedPeerNames)) {
    throw new Error(
      `Expected dist package.json to expose exactly ${expectedPeerNames.join(', ')} as peers, got ${actualPeerNames.join(', ')}.`,
    );
  }
  const expectedOptionalPeerNames = expectedPeerNames.filter(
    (packageName) => packageName !== 'typescript',
  );
  const actualPeerMetaNames = Object.keys(
    manifest.peerDependenciesMeta ?? {},
  ).toSorted((left, right) => Number(left > right) - Number(left < right));
  if (
    JSON.stringify(actualPeerMetaNames) !==
    JSON.stringify(expectedOptionalPeerNames)
  ) {
    throw new Error(
      `Expected dist package.json peer metadata for exactly ${expectedOptionalPeerNames.join(', ')}, got ${actualPeerMetaNames.join(', ')}.`,
    );
  }

  for (const [packageName, expectedRange] of Object.entries(
    EXPECTED_PEER_RANGES,
  )) {
    const actualRange = getPeerDependencyRange(manifest, packageName);
    if (actualRange !== expectedRange) {
      throw new Error(
        `Expected dist package.json peerDependencies.${packageName} to equal "${expectedRange}", got "${actualRange}".`,
      );
    }
    const isExpectedOptional = packageName !== 'typescript';
    const isActualOptional =
      manifest.peerDependenciesMeta?.[packageName]?.optional === true;
    if (isActualOptional !== isExpectedOptional) {
      throw new Error(
        `Expected dist package.json peer ${packageName} optional=${isExpectedOptional}, got optional=${isActualOptional}.`,
      );
    }
  }

  const dependencySections = Object.entries({
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    peerDependenciesMeta: manifest.peerDependenciesMeta,
  });
  for (const packageName of CHECKER_INTERNAL_PACKAGES) {
    for (const [sectionName, section] of dependencySections) {
      if (section?.[packageName] !== undefined) {
        throw new Error(
          `Expected dist package.json not to declare checker-internal package ${packageName} in ${sectionName}.`,
        );
      }
    }
  }

  return manifest;
}

export function packLiminaDistribution(): Promise<PackedDistributionTarball> {
  return packDistribution(DIST_DIR);
}

export function packMigrationDistribution(): Promise<PackedDistributionTarball> {
  return packDistribution(path.resolve(PACKAGE_ROOT_DIR, '../migrate/dist'));
}

async function packDistribution(
  distributionDirectory: string,
): Promise<PackedDistributionTarball> {
  const destination = await mkdtemp(path.join(tmpdir(), 'limina-package-'));

  try {
    const result = await execa(
      getNpmCommand(),
      [
        'pack',
        distributionDirectory,
        '--pack-destination',
        destination,
        '--ignore-scripts',
      ],
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
      throw new Error(
        `npm pack did not report a tarball for ${distributionDirectory}`,
      );
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

    return rawValue === 'undefined' ||
      rawValue === 'null' ||
      rawValue.length === 0
      ? undefined
      : (JSON.parse(rawValue) as T);
  } catch {
    return undefined;
  }
}

async function createConsumerPackageManagerSettings(): Promise<string[]> {
  const trustPolicy = await readCurrentPnpmConfig<string>('trust-policy');
  const trustPolicyExcludes =
    (await readCurrentPnpmConfig<string[]>('trust-policy-exclude')) ?? [];
  const lines: string[] = [
    'autoInstallPeers: false',
    'strictPeerDependencies: true',
  ];

  if (trustPolicy) {
    lines.push(`trustPolicy: ${JSON.stringify(trustPolicy)}`);
  }

  if (trustPolicyExcludes.length > 0) {
    lines.push('trustPolicyExclude:');
    for (const exclude of trustPolicyExcludes) {
      lines.push(`  - ${JSON.stringify(exclude)}`);
    }
  }

  return lines;
}

async function writeConsumerFiles(
  fixtureDirectory: string,
  configFileName: string,
  options: { astroSemanticFixture: boolean },
): Promise<void> {
  const pnpmVersionResult = await runPnpm(['--version'], {
    cwd: fixtureDirectory,
    timeout: 30_000,
  });
  const pnpmVersion = pnpmVersionResult.stdout.trim();

  await mkdir(path.join(fixtureDirectory, 'app', 'src'), { recursive: true });
  await mkdir(path.join(fixtureDirectory, 'release-dist'), { recursive: true });

  await writeFile(
    path.join(fixtureDirectory, 'package.json'),
    stringifyJson({
      name: 'limina-consumer-smoke',
      packageManager: `pnpm@${pnpmVersion}`,
      private: true,
      type: 'module',
    }),
    'utf8',
  );

  await writeFile(
    path.join(fixtureDirectory, 'pnpm-workspace.yaml'),
    [
      'packages:',
      '  - app',
      ...(await createConsumerPackageManagerSettings()),
      ...(options.astroSemanticFixture
        ? [
            'overrides:',
            "  '@astrojs/check>@astrojs/language-server': 2.16.13",
            "  '@astrojs/language-server>@astrojs/compiler': 2.13.1",
            "  '@astrojs/language-server>@volar/language-core': 2.4.28",
            "  '@astrojs/language-server>@volar/kit': 2.4.28",
            "  '@volar/kit>@volar/typescript': 2.4.28",
          ]
        : []),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, configFileName),
    `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      ${options.astroSemanticFixture ? 'astro' : 'tsc'}: {
        include: ['app/tsconfig.json'],
      },
    },
    source: {
      include: [${options.astroSemanticFixture ? "'**/*.ts', '**/*.astro'" : "'**/*.ts'"}],
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
    path.join(fixtureDirectory, 'app', 'package.json'),
    stringifyJson({
      name: '@limina-smoke/app',
      type: 'module',
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'app', 'src', 'index.ts'),
    'export const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'app', 'tsconfig.json'),
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
    path.join(fixtureDirectory, 'app', 'tsconfig.lib.json'),
    stringifyJson({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        noEmit: true,
        strict: true,
        target: 'ES2023',
        types: [],
        ...(options.astroSemanticFixture && { allowArbitraryExtensions: true }),
      },
      include: [options.astroSemanticFixture ? 'src/**/*' : 'src/**/*.ts'],
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'package.json'),
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
    path.join(fixtureDirectory, 'release-dist', 'index.js'),
    'export const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'index.d.ts'),
    'export declare const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'README.md'),
    '# Release fixture\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'LICENSE.md'),
    'MIT\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'verify-exports.mjs'),
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
let internalExportRejected = false;
try {
  await import('limina/internal/migration');
} catch (error) {
  internalExportRejected = Boolean(error) && typeof error === 'object' && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}
if (!internalExportRejected) throw new Error('Published Limina must not expose workspace-only migration support.');
if (manifest.name !== 'limina') {
  throw new Error('limina/package.json did not resolve to the installed package.');
}
if (!schema || typeof schema !== 'object') {
  throw new Error('limina schema export did not resolve to JSON content.');
}
try {
  import.meta.resolve('svelte2tsx');
  throw new Error('The non-Svelte consumer unexpectedly installed svelte2tsx.');
} catch (error) {
  if (error instanceof Error && error.message.includes('unexpectedly installed')) {
    throw error;
  }
}

console.log('limina exports ok');
`,
    'utf8',
  );
}

export async function installConsumerDependencies(options: {
  astroSemanticFixture: boolean;
  astroToolchain?: AstroConsumerToolchain;
  fixtureDir: string;
  manifest: DistributionPackageJson;
  tarballPath: string;
}): Promise<void> {
  const typescriptRange =
    options.astroToolchain?.typeScriptVersion ??
    getPeerDependencyRange(options.manifest, 'typescript');
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

  if (options.astroSemanticFixture) {
    await runPnpm(
      [
        '--filter',
        '@limina-smoke/app',
        'add',
        '--save-dev',
        '--prefer-offline',
        '--ignore-scripts',
        'astro@7.3.2',
        `@astrojs/check@${options.astroToolchain?.checkVersion ?? '0.9.10'}`,
        `typescript@${options.astroToolchain?.typeScriptVersion ?? '6.0.3'}`,
      ],
      {
        cwd: options.fixtureDir,
        inherit: true,
        timeout: 300_000,
      },
    );
  }

  await runPnpm(['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: options.fixtureDir,
    inherit: true,
    timeout: 300_000,
  });
}

export async function createConsumerFixture(options: {
  astroSemanticFixture?: boolean;
  astroToolchain?: AstroConsumerToolchain;
  configFileName?: string;
  directoryName?: string;
  manifest: DistributionPackageJson;
  sourceText?: string;
  tarballPath: string;
}): Promise<ConsumerFixture> {
  // Windows temp paths can contain DOS short names. Use one real path for
  // pnpm's project and workspace roots so add and frozen install agree on
  // the lockfile importer without changing the special-character fixture.
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'limina-smoke-'));
  const fixtureRoot = await realpath(temporaryRoot);
  const configFileName = options.configFileName ?? 'limina.config.mjs';
  const fixtureDirectory = path.join(
    fixtureRoot,
    options.directoryName ?? 'fixture',
  );

  try {
    await mkdir(fixtureDirectory, {
      recursive: true,
    });
    await writeConsumerFiles(fixtureDirectory, configFileName, {
      astroSemanticFixture: options.astroSemanticFixture === true,
    });
    if (options.sourceText !== undefined) {
      await writeFile(
        path.join(fixtureDirectory, 'app', 'src', 'index.ts'),
        options.sourceText,
        'utf8',
      );
    }
    await installConsumerDependencies({
      astroSemanticFixture: options.astroSemanticFixture === true,
      astroToolchain: options.astroToolchain,
      fixtureDir: fixtureDirectory,
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
      configPath: path.join(fixtureDirectory, configFileName),
      fixtureDir: fixtureDirectory,
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
