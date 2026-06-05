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
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  entry: 'tsconfig.build.json',
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
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
        path.join(rootDir, 'app/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
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
  }, 15_000);

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
  }, 30_000);

  it('runs nx sync with repeated targets from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-nx-sync-')),
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
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );
      await writeText(
        path.join(rootDir, 'packages/a/package.json'),
        stringifyConfig({
          dependencies: {
            '@example/b': 'link:../b/dist',
          },
          name: '@example/a',
          scripts: {
            build: 'echo build',
          },
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/package.json'),
        stringifyConfig({
          name: '@example/b',
          scripts: {
            build: 'echo build',
          },
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'nx',
          'sync',
          'docs:build',
          'build',
          'docs:build',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina nx sync');
      expect(result.stdout).toContain('limina nx passed');
      expect(
        await readFile(path.join(rootDir, 'packages/a/project.json'), 'utf8'),
      ).toContain('"docs:build"');
      expect(
        await readFile(path.join(rootDir, 'packages/a/project.json'), 'utf8'),
      ).toContain('"@example/b"');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('runs graph sync with a declaration leaf path from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-graph-sync-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  entry: 'tsconfig.build.json',
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'app/node.ts'),
        'export const nodeValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/runtime.ts'),
        "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.node.dts.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['node.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.runtime.dts.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            tsBuildInfoFile: './.tsbuild/runtime.tsbuildinfo',
          },
          include: ['runtime.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'tsconfig.build.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './app/tsconfig.node.dts.json',
            },
            {
              path: './app/tsconfig.runtime.dts.json',
            },
          ],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'graph',
          'sync',
          'app/tsconfig.runtime.dts.json',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina graph sync');
      expect(result.stdout).toContain('limina graph passed');
      expect(
        await readFile(
          path.join(rootDir, 'app/tsconfig.runtime.dts.json'),
          'utf8',
        ),
      ).toContain('"path": "./tsconfig.node.dts.json"');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('runs nx check with the default build target from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-nx-check-')),
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
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );
      await writeText(
        path.join(rootDir, 'packages/a/package.json'),
        stringifyConfig({
          name: '@example/a',
          scripts: {
            build: 'echo build',
          },
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/project.json'),
        stringifyConfig({
          name: '@example/a',
          targets: {
            build: {
              dependsOn: [],
            },
          },
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'nx',
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

      expect(result.stdout).toContain('limina nx check');
      expect(result.stdout).toContain('limina nx passed');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('rejects the old nx generate action from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-nx-generate-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );

      await expect(
        execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'nx',
            'generate',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'Unknown nx action "generate". Expected sync or check.',
        ),
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('rejects removed paths commands from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-paths-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );

      await expect(
        execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'paths',
            'check',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('Unknown command'),
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

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
  }, 30_000);
});
