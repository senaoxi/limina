import { execFileSync } from 'node:child_process';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createSinglePackageFixture } from './helpers/single-package';

const checkers = [
  {
    name: 'astro',
    extension: 'astro',
    packages: { astro: 'astro', '@astrojs/check': '@astrojs/check' },
  },
  {
    name: 'svelte-check',
    extension: 'svelte',
    packages: {
      svelte: 'svelte-v4-min',
      'svelte-check': 'svelte-check-v4-min',
      svelte2tsx: 'svelte2tsx',
    },
  },
] as const;

it.each(checkers)(
  'restores $name source roots and its execution scope on a graph hit',
  async ({ name, extension, packages }) => {
    const installedPackages = Object.entries({
      typescript: 'typescript',
      ...packages,
    });
    const devDependencies = Object.fromEntries(
      installedPackages.map(([name]) => [name, '*']),
    );
    const component = `src/Widget.${extension}`;
    const fixture = await createSinglePackageFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        packageManager: 'npm@11.6.1',
        devDependencies,
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {} },
      }),
      'limina.config.mjs': `export default ${JSON.stringify({ scope: { source: { include: ['src/**/*'] }, checkers: { [name]: { include: ['tsconfig.json'] } } }, source: { knip: false } })};`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          skipLibCheck: true,
          types: [],
        },
        include: ['src/**/*', `src/**/*.${extension}`],
      }),
      [component]: '<p>first</p>',
      'src/local.ts': 'export const local = 1;',
    });
    try {
      for (const [target, installed] of installedPackages) {
        const source = fileURLToPath(
          new URL(`../../node_modules/${installed}`, import.meta.url),
        );
        const link = fixture.path('node_modules', target);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(await realpath(source), link, 'junction');
      }
      const run = (phase: 'cold' | 'warm') => {
        const text = execFileSync(
          process.execPath,
          [
            '--import',
            pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
            fileURLToPath(
              new URL('helpers/framework-cache-runner.ts', import.meta.url),
            ),
            name,
            fixture.path(component),
            phase,
          ],
          { cwd: fixture.rootDir, encoding: 'utf8' },
        );
        return JSON.parse(text.trim().split('\n').at(-1)!);
      };
      const cold = run('cold');
      const warm = run('warm');
      expect(cold.programCreates).toBeGreaterThan(0);
      expect(warm).toEqual({
        graphHits: 1,
        programCreates: 0,
        configFile: fixture.path('tsconfig.json'),
        roots: expect.arrayContaining([
          fixture.path(component),
          fixture.path('src/local.ts'),
        ]),
      });
    } finally {
      await fixture.cleanup();
    }
  },
);
