import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ResourceResolver } from '../core/facts/resource-resolver';
import { collectTypeScriptSourceTextImports } from '../core/import-analysis/typescript-imports';
import { toPortablePath } from './helpers/path';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

it.each(['exports', 'imports', 'exact-imports'])(
  'isolates occurrence modes and custom conditions for %s resources',
  async (field) => {
    const specifier =
      field === 'exports'
        ? 'asset/theme.css'
        : field === 'imports'
          ? '#theme.css'
          : '#theme?raw';
    const branches = {
      browser: './browser.css',
      import: './esm.css',
      require: './cjs.css',
    };
    const fixture = await createSemanticRepairFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        type: 'module',
        imports: { [specifier]: branches },
      }),
      'node_modules/asset/package.json': JSON.stringify({
        name: 'asset',
        exports: { './theme.css': branches },
      }),
      'esm.css': '',
      'cjs.css': '',
      'browser.css': '',
      'node_modules/asset/esm.css': '',
      'node_modules/asset/cjs.css': '',
      'node_modules/asset/browser.css': '',
    });
    const resolver = new ResourceResolver();
    const [importRecord] = collectTypeScriptSourceTextImports({
      filePath: fixture.path('main.ts'),
      sourceText: `import '${specifier}';`,
    });
    const prefix = field === 'exports' ? 'node_modules/asset/' : '';
    try {
      for (const [mode, conditions, target] of [
        ['import', [], 'esm.css'],
        ['require', [], 'cjs.css'],
        ['import', ['browser'], 'browser.css'],
        ['1', [], 'cjs.css'],
        ['99', [], 'esm.css'],
        ['require', ['browser'], 'browser.css'],
        ['import', [], 'esm.css'],
      ] as const) {
        expect(
          resolver.resolve({
            importRecord: importRecord!,
            resolutionMode: mode,
            options: { customConditions: [...conditions] },
          }),
        ).toMatchObject({
          authority: field === 'exact-imports' ? 'package-export' : 'oxc',
          kind: 'file',
          filePath: fixture.path(prefix + target),
        });
      }
    } finally {
      resolver.dispose();
      await fixture.cleanup();
    }
  },
);

it.each([
  {
    mode: 'import',
    branches: { import: './missing.css', require: './exists.css' },
    present: false,
  },
  {
    mode: 'require',
    branches: { import: './exists.css', require: './missing.css' },
    present: false,
  },
  { mode: 'import', branches: { import: './exists.css' }, present: true },
  { mode: 'require', branches: { require: './exists.css' }, present: true },
  {
    mode: 'import',
    branches: { import: null, default: './exists.css' },
    present: false,
  },
])(
  'uses only the active $mode branch: $branches',
  async ({ mode, branches, present }) => {
    const fixture = await createSemanticRepairFixture({
      'node_modules/asset/package.json': JSON.stringify({
        name: 'asset',
        exports: { './theme.css': branches },
      }),
      'node_modules/asset/exists.css': '',
    });
    const resolver = new ResourceResolver();
    try {
      const [importRecord] = collectTypeScriptSourceTextImports({
        filePath: fixture.path('main.ts'),
        sourceText: "import 'asset/theme.css';",
      });
      expect(
        resolver.resolve({
          importRecord: importRecord!,
          options: {},
          resolutionMode: mode,
        }).kind,
      ).toBe(present ? 'file' : 'missing');
    } finally {
      resolver.dispose();
      await fixture.cleanup();
    }
  },
);

it.each([
  ['exports', 'module-sync', 'import'],
  ['exports', 'node-addons', 'require'],
  ['imports', 'module-sync', 'import'],
  ['exports', 'module-sync', 'require'],
] as const)(
  'matches Node default conditions for %s %s %s',
  async (field, condition, mode) => {
    const specifier = field === 'exports' ? 'asset/theme.css' : '#theme.css';
    const branches = { [condition]: './active.css', default: './fallback.css' };
    const fixture = await createSemanticRepairFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        type: 'module',
        imports: { '#theme.css': branches },
      }),
      'node_modules/asset/package.json': JSON.stringify({
        name: 'asset',
        exports: { './theme.css': branches },
      }),
      'node_modules/asset/active.css': '',
      'node_modules/asset/fallback.css': '',
      'active.css': '',
      'fallback.css': '',
    });
    const resolver = new ResourceResolver();
    const [importRecord] = collectTypeScriptSourceTextImports({
      filePath: fixture.path('main.ts'),
      sourceText: `import '${specifier}';`,
    });
    try {
      const oracle = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const result = ${mode === 'import' ? `import.meta.resolve(${JSON.stringify(specifier)})` : `pathToFileURL(createRequire(import.meta.url).resolve(${JSON.stringify(specifier)})).href`};
      console.log(JSON.stringify(result));
    `,
          ],
          { cwd: fixture.root, encoding: 'utf8' },
        ),
      ) as string;
      const expected = fileURLToPath(oracle).endsWith('active.css')
        ? 'active.css'
        : 'fallback.css';
      expect(
        resolver.resolve({
          importRecord: importRecord!,
          resolutionMode: mode,
          options: {},
        }),
      ).toMatchObject({
        authority: 'package-export',
        kind: 'file',
        filePath: fixture.path(
          field === 'exports' ? 'node_modules/asset' : '.',
          expected,
        ),
      });
    } finally {
      resolver.dispose();
      await fixture.cleanup();
    }
  },
);

it('preserves complete package-import keys at physical resolution', async () => {
  const imports = {
    '#foo': './base.svg',
    '#foo/bar': './nested.svg',
    '#foo?raw': './raw.svg',
    '#foo#fragment': './fragment.svg',
  };
  const fixture = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'fixture',
      type: 'module',
      imports,
    }),
    ...Object.fromEntries(
      Object.values(imports).map((target) => [target, '<svg />\n']),
    ),
  });
  const resolver = new ResourceResolver();
  try {
    const filePath = fixture.path('index.ts');
    const records = collectTypeScriptSourceTextImports({
      filePath,
      sourceText: Object.keys(imports)
        .map((specifier) => `import ${JSON.stringify(specifier)};`)
        .join('\n'),
    });
    const requireFromFixture = createRequire(pathToFileURL(filePath));
    for (const importRecord of records) {
      const expectedPath = toPortablePath(
        requireFromFixture.resolve(importRecord.specifier),
      );
      expect(
        resolver.resolve({
          importRecord,
          options: {},
          resolutionMode: 'import',
        }),
      ).toMatchObject({ kind: 'file', filePath: expectedPath });
    }
    expect(records).toHaveLength(Object.keys(imports).length);
  } finally {
    resolver.dispose();
    await fixture.cleanup();
  }
});
