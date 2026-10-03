import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  assertPackageModuleClosure,
  packLiminaDistribution,
  packMigrationDistribution,
  runCommand,
  runPnpm,
} from './helpers';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

it('consumes neutral inputs with only the packed migrate product, preserves schema ownership, and diagnoses missing config and loader packages before writing', async () => {
  const migration = await packMigrationDistribution();
  const core = await packLiminaDistribution();
  const temporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-migrate-standalone-'),
  );
  const root = await realpath(temporaryPath);
  const put = (file: string, content: string) =>
    writeFile(path.join(root, file), content);
  const cli = path.join(
    root,
    'node_modules/limina-migrate/bin/limina-migrate.js',
  );
  const node = (arguments_: string[]) =>
    runCommand(process.execPath, arguments_, { cwd: root, reject: false });
  const commit = async () => {
    await runCommand('git', ['add', '.'], { cwd: root });
    await runCommand(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--no-gpg-sign',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { cwd: root },
    );
  };
  try {
    await put(
      'package.json',
      json({
        name: 'standalone-consumer',
        private: true,
        type: 'module',
        devDependencies: {
          'limina-migrate': `file:${migration.tarballPath}`,
          typescript: '6.0.3',
        },
      }),
    );
    await put(
      'pnpm-workspace.yaml',
      'packages: []\nhoist: false\nautoInstallPeers: false\nstrictPeerDependencies: true\npackageImportMethod: copy\n',
    );
    await put('.gitignore', 'node_modules/\n.limina/\n');
    await put('limina.config.mjs', 'export default {};\n');
    await put(
      'tsconfig.json',
      json({
        compilerOptions: { strict: true, noEmit: true },
        files: ['index.ts'],
      }),
    );
    await put('index.ts', 'export const value: number = 1;\n');
    await runPnpm(['install', '--ignore-scripts', '--prefer-offline'], {
      cwd: root,
    });
    await expect(
      access(path.join(root, 'node_modules/limina')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const migrateRoot = await realpath(
      path.join(root, 'node_modules/limina-migrate'),
    );
    const manifest = JSON.parse(
      await readFile(path.join(migrateRoot, 'package.json'), 'utf8'),
    );
    await assertPackageModuleClosure(migrateRoot, manifest);
    const build = JSON.parse(
      await readFile(path.join(migrateRoot, 'migration-build.json'), 'utf8'),
    );
    expect(build).toEqual({
      formatVersion: 1,
      coreVersion: manifest.version,
      migrateVersion: manifest.version,
    });
    for (const resource of [
      'cli.js',
      'migration-verify-process.js',
      'flow-renderer-process.js',
      'LICENSE.md',
      'bundled-dependencies.json',
    ])
      await access(path.join(migrateRoot, resource));
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ])
      expect(manifest[section]?.limina).toBeUndefined();
    const help = await node([cli, '--help']);
    expect(help.exitCode).toBe(0);
    await runCommand('git', ['init'], { cwd: root });
    await commit();
    const migrated = await node([cli]);
    expect(migrated.exitCode, migrated.stdout + migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain(
      'not-installed from config and governance root',
    );
    expect(migrated.stdout).toContain(
      'Editor schema resolution may be unavailable',
    );
    expect(migrated.stdout).toContain('TypeScript peer@6.0.3');
    const before = await readFile(path.join(root, 'tsconfig.json'), 'utf8');
    expect(JSON.parse(before).$schema).toBe(
      './node_modules/limina/schemas/tsconfig-schema.json',
    );
    const readReport = async () =>
      JSON.parse(
        await readFile(
          path.join(root, '.limina/migration/latest.json'),
          'utf8',
        ),
      );
    const report = await readReport();
    expect(report.result.inputConsumable).toBe(true);
    expect(report.verification.diagnostics).toEqual([]);
    const worker = path.join(migrateRoot, 'migration-verify-process.js');
    const fresh = await node([
      worker,
      path.join(root, 'limina.config.mjs'),
      'native',
      'default',
    ]);
    expect(fresh.exitCode, fresh.stdout + fresh.stderr).toBe(0);
    const topology = JSON.parse(
      fresh.stdout.split('LIMINA_MIGRATION_INPUT=').at(-1)!,
    );
    expect(topology.map((entry: { command: string }) => entry.command)).toEqual(
      ['check', 'graph'],
    );
    for (const entry of topology) {
      expect(entry.complete).toBe(true);
      expect(entry.sources).toHaveLength(1);
      expect(entry.entries).toHaveLength(1);
    }
    await commit();
    const noTsx = await node([cli, '--config-loader', 'tsx']);
    expect(noTsx.exitCode).not.toBe(0);
    expect(noTsx.stderr).toContain('Please install `tsx`');
    expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
      before,
    );
    await put(
      'limina.config.mjs',
      'import { defineConfig } from "limina"; export default defineConfig({});\n',
    );
    await commit();
    const missingCore = await node([cli]);
    expect(missingCore.exitCode).not.toBe(0);
    expect(missingCore.stderr).toContain(
      'config imports the public "limina" package',
    );
    expect(missingCore.stderr).toContain('Install Limina in the project');
    expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
      before,
    );
    await runPnpm(
      [
        'add',
        '--save-dev',
        '--ignore-scripts',
        '--prefer-offline',
        core.tarballPath,
      ],
      { cwd: root },
    );
    await commit();
    const installedCore = await node([cli]);
    expect(
      installedCore.exitCode,
      installedCore.stdout + installedCore.stderr,
    ).toBe(0);
    expect(installedCore.stdout).toContain('observed-same-version');
    const installedCoreReport = await readReport();
    expect(installedCoreReport.result.inputConsumable).toBe(true);
    const coreRoot = await realpath(path.join(root, 'node_modules/limina'));
    const coreManifestText = await readFile(
      path.join(coreRoot, 'package.json'),
      'utf8',
    );
    const coreManifest = JSON.parse(coreManifestText);
    await assertPackageModuleClosure(coreRoot, coreManifest);
    expect(
      Object.keys(coreManifest.exports).filter(
        (key) => key === './internal' || key.startsWith('./internal/'),
      ),
    ).toEqual([]);
    const publicApi = await node([
      '--input-type=module',
      '--eval',
      'import { defineConfig } from "limina"; if (defineConfig({}).constructor !== Object) throw new Error("public config unavailable"); for (const specifier of ["limina/internal/core/tsconfig/actions", "limina/internal/config/runner", "limina/internal/logger"]) { try { await import(specifier); throw new Error("internal exported"); } catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; } }',
    ]);
    expect(publicApi.exitCode, publicApi.stdout + publicApi.stderr).toBe(0);
    await put(
      'public-config.ts',
      'import { defineConfig, type LiminaConfig } from "limina"; const config: LiminaConfig = {}; defineConfig(config);\n',
    );
    const publicTypes = await node([
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--strict',
      '--noEmit',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      'public-config.ts',
    ]);
    expect(publicTypes.exitCode, publicTypes.stdout + publicTypes.stderr).toBe(
      0,
    );
    // Remove the consumer's real compiler directory, without modifying store
    // contents, to challenge the required peer through the installed process.
    const typescriptRoot = await realpath(
      path.join(root, 'node_modules/typescript'),
    );
    await rename(typescriptRoot, `${typescriptRoot}.disabled`);
    try {
      const compilerlessHelp = await node([cli, '--help']);
      expect(compilerlessHelp.exitCode).toBe(0);
      const noCompiler = await node([cli]);
      expect(noCompiler.exitCode).not.toBe(0);
      expect(noCompiler.stderr).toContain('typescript');
      expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
        before,
      );
    } finally {
      await rename(`${typescriptRoot}.disabled`, typescriptRoot);
    }
    // Missing a worker dependency cannot reuse the last successful topology.
    const workerText = await readFile(worker, 'utf8');
    const dependency = /from ["'](\.\/chunks\/[^"']+)["']/u.exec(
      workerText,
    )?.[1];
    expect(dependency).toBeDefined();
    const chunk = path.resolve(migrateRoot, dependency!);
    await rename(chunk, `${chunk}.disabled`);
    try {
      const unavailable = await node([
        worker,
        path.join(root, 'limina.config.mjs'),
        'native',
        'default',
      ]);
      expect(unavailable.exitCode).not.toBe(0);
      expect(unavailable.stdout).not.toContain('LIMINA_MIGRATION_INPUT=');
    } finally {
      await rename(`${chunk}.disabled`, chunk);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await core.cleanup();
    await migration.cleanup();
  }
});
