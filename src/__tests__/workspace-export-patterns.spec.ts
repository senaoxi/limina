import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPackageExportEntries } from '../core/workspace/exports/entries';

describe('Node export pattern expansion', () => {
  it.each([
    {
      target: './dist/*.js',
      file: 'dist/nested/value.js',
      capture: 'nested/value',
    },
    {
      target: './dist/[raw]/*.js',
      file: 'dist/[raw]/value.js',
      capture: 'value',
    },
    { target: './dist/*/*.js', file: 'dist/value/value.js', capture: 'value' },
    { target: './dist/*/*.js', file: 'dist/a/b/a/b.js', capture: 'a/b' },
    { target: './dist/*.js', file: 'dist/$value.js', capture: '$value' },
  ])(
    'agrees with Node for $target -> $file',
    async ({ target, file, capture }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'limina-export-pattern-'),
      );
      const manifest = {
        name: 'pattern-fixture',
        type: 'module',
        exports: { './feature-*': target },
      };
      try {
        await writeFile(
          path.join(directory, 'package.json'),
          JSON.stringify(manifest),
        );
        await mkdir(path.dirname(path.join(directory, file)), {
          recursive: true,
        });
        await writeFile(path.join(directory, file), 'export default 42;');
        await mkdir(path.join(directory, 'dist/unmatched'), {
          recursive: true,
        });
        await writeFile(path.join(directory, 'dist/unmatched/other.txt'), '');
        const collected = await collectPackageExportEntries({
          directory,
          name: manifest.name,
          manifest,
        });
        expect(collected.problems).toEqual([]);
        const specifier = `${manifest.name}/feature-${capture}`;
        expect(collected.entries).toMatchObject([
          { specifier, targets: [`./${file}`] },
        ]);
        const execution = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import(${JSON.stringify(specifier)}).then(m => process.stdout.write(String(m.default)))`,
          ],
          { cwd: directory, encoding: 'utf8' },
        );
        expect(execution.status, execution.stderr).toBe(0);
        expect(execution.stdout.trim()).toBe('42');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects empty captures like Node', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'limina-export-pattern-'),
    );
    const manifest = {
      name: 'pattern-fixture',
      type: 'module',
      exports: { './feature-*': './dist/pre*.js' },
    };
    try {
      await mkdir(path.join(directory, 'dist'));
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify(manifest),
      );
      await writeFile(path.join(directory, 'dist/pre.js'), 'export {};');
      const collected = await collectPackageExportEntries({
        directory,
        name: manifest.name,
        manifest,
      });
      expect(collected.entries).toEqual([]);
      const execution = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', 'import("pattern-fixture/feature-")'],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(execution.status).toBe(1);
      expect(execution.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not accept different captures at repeated stars', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'limina-export-pattern-'),
    );
    try {
      await mkdir(path.join(directory, 'dist/a'), { recursive: true });
      await writeFile(path.join(directory, 'dist/a/b.js'), 'export {};');
      const collected = await collectPackageExportEntries({
        directory,
        name: 'pattern-fixture',
        manifest: {
          name: 'pattern-fixture',
          exports: { './*': './dist/*/*.js', './private/*': null },
        },
      });
      expect(collected.entries).toEqual([]);
      expect(collected.problems).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
