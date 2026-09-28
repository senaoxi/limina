import licensePlugin from '@limina/build-tools/license';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { defineConfig, type RolldownOptions } from 'rolldown';
import pkg from './package.json' with { type: 'json' };
import packagePlugin from './packagePlugin';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
let hasCleanedDist = false;
const packageExternalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // @ts-expect-error No type checking is needed here.
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

function isPackageExternal(id: string): boolean {
  return packageExternalDeps.some(
    (dependencyName) =>
      id === dependencyName || id.startsWith(`${dependencyName}/`),
  );
}

function resolveJsoncParserEsmEntry(): string {
  const packageJsonPath = fileURLToPath(
    import.meta.resolve('jsonc-parser/package.json'),
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    module?: unknown;
  };

  if (
    typeof packageJson.module !== 'string' ||
    packageJson.module.length === 0
  ) {
    throw new TypeError(
      'jsonc-parser package.json must define a module entry.',
    );
  }

  return path.resolve(path.dirname(packageJsonPath), packageJson.module);
}

const jsoncParserEsmEntry = resolveJsoncParserEsmEntry();

const jsoncParserEsmPlugin = (): NonNullable<RolldownOptions['plugins']> => ({
  name: 'rolldown-plugin-jsonc-parser-esm',
  resolveId(source) {
    return source === 'jsonc-parser' ? jsoncParserEsmEntry : null;
  },
});

const cleanDistPlugin = (): NonNullable<RolldownOptions['plugins']> => ({
  name: 'rolldown-plugin-clean-dist',
  async buildStart() {
    if (hasCleanedDist) {
      return;
    }

    hasCleanedDist = true;
    await rm(path.resolve(packageDir, 'dist'), {
      force: true,
      recursive: true,
    });
  },
});

const moduleConfig: RolldownOptions = defineConfig({
  input: {
    cli: 'src/cli.ts',
    'migration-verify-process': 'src/migration/verify-process.ts',
    'bin/limina-migrate': 'bin/limina-migrate.js',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external: isPackageExternal,
  plugins: [
    cleanDistPlugin(),
    // Prefer jsonc-parser's ESM `module` entry because its 3.x UMD `main` entry
    // uses indirect `require` calls that cannot be reliably analyzed by bundlers.
    // Remove this override after upgrading to the ESM-only jsonc-parser 4.x.
    jsoncParserEsmPlugin(),
    packagePlugin(),
    licensePlugin(
      path.resolve(packageDir, 'LICENSE.md'),
      'limina-migrate license',
      'limina-migrate',
      path.resolve(packageDir, '../../LICENSE'),
    ),
  ],
  output: {
    dir: 'dist',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/dep-[hash].js',
    exports: 'named',
    format: 'esm',
  },
});

export default moduleConfig;
