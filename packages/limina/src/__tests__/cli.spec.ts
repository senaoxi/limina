import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  rootDir: '.',
  strict: true,
  target: 'ES2023',
  tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
  types: [],
};

describe('limina CLI', () => {
  it('runs source check from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            checkers: {
              typescript: {
                entry: 'tsconfig.build.json',
                preset: 'tsc',
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'tsconfig.build.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './app/tsconfig.lib.dts.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: '@example/app',
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.dts.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'source',
          'check',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina source check');
      expect(result.stdout).toContain('limina source passed');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15000);

  it('runs release check with repeated package filters from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-release-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    async function writePackage(packageName: string): Promise<void> {
      const packageDirName = packageName.split('/').at(-1) ?? packageName;
      const packageDir = path.join(rootDir, 'packages', packageDirName);
      const outDir = path.join(packageDir, 'dist');

      await writeText(
        path.join(packageDir, 'package.json'),
        stringifyConfig({
          name: packageName,
          version: '1.0.0',
        }),
      );
      await writeText(path.join(packageDir, 'src/index.ts'), 'export {};\n');
      await writeText(
        path.join(outDir, 'package.json'),
        stringifyConfig({
          exports: {
            '.': './index.js',
          },
          license: 'MIT',
          name: packageName,
          types: './index.d.ts',
          version: '1.0.0',
        }),
      );
      await writeText(
        path.join(outDir, 'index.js'),
        'export const value = 1;\n',
      );
      await writeText(path.join(outDir, 'README.md'), '# Example package\n');
      await writeText(path.join(outDir, 'LICENSE.md'), 'MIT\n');
    }

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writePackage('@example/a');
      await writePackage('@example/b');
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            package: {
              entries: [
                {
                  name: '@example/a',
                  outDir: 'packages/a/dist',
                },
                {
                  name: '@example/b',
                  outDir: 'packages/b/dist',
                },
              ],
            },
          },
          null,
          2,
        )};\n`,
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'release',
          'check',
          '--package',
          '@example/a',
          '--package',
          '@example/b',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina release check');
      expect(result.stdout).toContain('limina release passed');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 30000);

  it('runs init from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-init-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/package.json'),
        stringifyConfig({
          name: 'app',
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.json'),
        stringifyConfig({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [cliPath, 'init', '--yes'],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina init');
      expect(result.stdout).toContain('limina init finished');
      expect(
        await readFile(
          path.join(rootDir, 'packages/app/tsconfig.dts.json'),
          'utf8',
        ),
      ).toContain('./.limina/tsconfig.tsbuildinfo');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 30000);
});
