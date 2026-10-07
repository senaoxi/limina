import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  packLiminaDistribution,
  packMigrationDistribution,
  runCommand,
  runPnpm,
} from './helpers';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function corruptEmbeddedCoreVersion(text: string): string | undefined {
  const source = ts.createSourceFile('chunk.js', text, ts.ScriptTarget.Latest);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'coreVersion'
    )
      initializer ??= node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return initializer === undefined
    ? undefined
    : `${text.slice(0, initializer.getStart(source))}"99.0.0"${text.slice(initializer.end)}`;
}

it('runs packed migration, preserves legacy argv and isolates verifier and version failures', async () => {
  const core = await packLiminaDistribution();
  const migration = await packMigrationDistribution();
  const temporaryPath = await mkdtemp(
    path.join(tmpdir(), "limina migrate ! & ' "),
  );
  const root = await realpath(temporaryPath);
  const put = async (file: string, content: string) =>
    writeFile(path.join(root, file), content);
  const node = (arguments_: string[], environment?: NodeJS.ProcessEnv) =>
    runCommand(process.execPath, arguments_, {
      cwd: root,
      env: environment,
      reject: false,
    });
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
  const coreBin = path.join(root, 'node_modules/limina/bin/limina.js');
  const migrateBin = path.join(
    root,
    'node_modules/limina-migrate/bin/limina-migrate.js',
  );
  try {
    await put(
      'package.json',
      json({
        name: 'packed-migration',
        private: true,
        type: 'module',
        devDependencies: {
          limina: `file:${core.tarballPath}`,
          typescript: '6.0.3',
        },
      }),
    );
    await put(
      'pnpm-workspace.yaml',
      `packages: []\nhoist: false\nautoInstallPeers: false\npackageImportMethod: copy\noverrides:\n  limina: ${JSON.stringify(`file:${core.tarballPath}`)}\n`,
    );
    await put('.gitignore', 'node_modules/\n.limina/\n');
    await put(
      'limina.config.mjs',
      `export default ({ command, mode }) => {
      if (!['migration', 'check', 'graph'].includes(command)) throw new Error('wrong command');
      if (mode !== 'mode with ! & quotes') throw new Error('wrong mode');
      return {};
    };\n`,
    );
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
    const coreHelp = await node([coreBin, '--help']);
    expect(coreHelp.exitCode).toBe(0);
    const help = await node([coreBin, 'migration', '--help'], {
      npm_config_offline: 'true',
    });
    expect(help.exitCode, help.stdout + help.stderr).toBe(0);
    expect(help.stdout).toContain('limina-migrate');
    await runPnpm(
      [
        'add',
        '--save-dev',
        '--ignore-scripts',
        '--prefer-offline',
        migration.tarballPath,
      ],
      { cwd: root },
    );
    await runCommand('git', ['init'], { cwd: root });
    await commit();
    const arguments_ = [
      '--mode',
      'mode with ! & quotes',
      '--config',
      'limina.config.mjs',
    ];
    const first = await node([migrateBin, ...arguments_]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('embedded Limina@');
    expect(first.stdout).toContain('observed-same-version');
    const before = await readFile(path.join(root, 'tsconfig.json'), 'utf8');
    await commit();
    const legacy = await node([
      coreBin,
      ...arguments_.slice(0, 2),
      'migration',
      ...arguments_.slice(2),
    ]);
    expect(legacy.exitCode, legacy.stdout + legacy.stderr).toBe(0);
    expect(legacy.stderr).toContain('deprecated');
    expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
      before,
    );
    const migrateRoot = await realpath(
      path.join(root, 'node_modules/limina-migrate'),
    );
    const worker = path.join(migrateRoot, 'migration-verify-process.js');
    await rename(worker, `${worker}.disabled`);
    try {
      const missing = await node([migrateBin, ...arguments_]);
      expect(missing.exitCode).not.toBe(0);
      const report = JSON.parse(
        await readFile(
          path.join(root, '.limina/migration/latest.json'),
          'utf8',
        ),
      );
      expect(report.result.inputConsumable).toBe(false);
      expect(report.verification.diagnostics.join('\n')).toContain(
        'verifier is unavailable',
      );
    } finally {
      await rename(`${worker}.disabled`, worker);
    }
    const manifestPath = path.join(root, 'node_modules/limina/package.json');
    const manifestText = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    await writeFile(manifestPath, json({ ...manifest, version: '99.0.0' }));
    try {
      const mismatch = await node([migrateBin, ...arguments_]);
      expect(mismatch.exitCode, mismatch.stdout + mismatch.stderr).toBe(0);
      expect(mismatch.stdout).toContain('Project Limina@99.0.0');
      expect(mismatch.stdout).toContain('observed-different-version');
      expect(mismatch.stdout).toContain(
        'project runtime is not the verification target',
      );
      expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
        before,
      );
    } finally {
      await writeFile(manifestPath, manifestText);
    }
    await writeFile(manifestPath, json({ ...manifest, version: '' }));
    try {
      const unknown = await node([migrateBin, ...arguments_]);
      expect(unknown.exitCode, unknown.stdout + unknown.stderr).toBe(0);
      expect(unknown.stdout).toContain('Project Limina version: unavailable');
      expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
        before,
      );
    } finally {
      await writeFile(manifestPath, manifestText);
    }
    // Self metadata must agree with the implementation, even without a core
    // runtime dependency. This error occurs before any user writes.
    const selfManifestPath = path.join(migrateRoot, 'package.json');
    const selfManifestText = await readFile(selfManifestPath, 'utf8');
    await writeFile(
      selfManifestPath,
      json({ ...JSON.parse(selfManifestText), version: '99.0.0' }),
    );
    try {
      const invalidBuild = await node([migrateBin, ...arguments_]);
      expect(invalidBuild.exitCode).not.toBe(0);
      expect(invalidBuild.stderr).toContain('Invalid limina-migrate build');
      expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
        before,
      );
      const invalidWorker = await node([
        worker,
        path.join(root, 'limina.config.mjs'),
        'native',
        'mode with ! & quotes',
      ]);
      expect(invalidWorker.exitCode).not.toBe(0);
      expect(invalidWorker.stderr).toContain('Invalid limina-migrate build');
      expect(invalidWorker.stdout).not.toContain('LIMINA_MIGRATION_INPUT=');
    } finally {
      await writeFile(selfManifestPath, selfManifestText);
    }
    // Corrupt a consumer artifact's actual embedded core version while the
    // installed self manifest and build metadata stay unchanged.
    const chunks = await readdir(path.join(migrateRoot, 'chunks'));
    let hasExercisedEmbeddedVersion = false;
    for (const chunk of chunks) {
      const chunkPath = path.join(migrateRoot, 'chunks', chunk);
      const text = await readFile(chunkPath, 'utf8');
      const corrupted = corruptEmbeddedCoreVersion(text);
      if (corrupted === undefined) continue;
      hasExercisedEmbeddedVersion = true;
      await writeFile(chunkPath, corrupted);
      try {
        const invalidCore = await node([migrateBin, ...arguments_]);
        expect(invalidCore.exitCode).not.toBe(0);
        expect(invalidCore.stderr).toContain('embedded Limina@99.0.0');
        expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe(
          before,
        );
      } finally {
        await writeFile(chunkPath, text);
      }
      break;
    }
    expect(hasExercisedEmbeddedVersion).toBe(true);
    // A real separate Node launcher records transport without requesting a public package.
    const migrateManifest = path.join(migrateRoot, 'package.json');
    const original = await readFile(migrateManifest, 'utf8');
    await writeFile(
      migrateManifest,
      json({ ...JSON.parse(original), version: '99.0.0' }),
    );
    await mkdir(path.join(root, 'launcher'));
    const npx = path.join(root, 'launcher/npx-cli.js');
    await writeFile(
      npx,
      'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n',
    );
    try {
      const fallback = await node(
        [
          coreBin,
          ...arguments_.slice(0, 2),
          'migration',
          ...arguments_.slice(2),
        ],
        {
          // Vitest adds uppercase env keys on Windows; Node keeps that variant.
          npm_execpath: npx,
          NPM_EXECPATH: npx,
          npm_config_offline: 'true',
          NPM_CONFIG_OFFLINE: 'true',
        },
      );
      expect(fallback.exitCode, fallback.stdout + fallback.stderr).toBe(0);
      const observed = JSON.parse(fallback.stdout.trim().split('\n').at(-1)!);
      expect(observed).toEqual({
        argv: ['--yes', `limina-migrate@${manifest.version}`, ...arguments_],
        cwd: root,
      });
    } finally {
      await writeFile(migrateManifest, original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await core.cleanup();
    await migration.cleanup();
  }
});
