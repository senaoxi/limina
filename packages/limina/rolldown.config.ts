import licensePlugin from '@docs-islands/plugin-license';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { defineConfig, type RolldownOptions } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';
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
    'checker-host-process': 'src/typecheck/host-process.ts',
    'flow-renderer-process': 'src/flow/renderer-process.ts',
    index: 'src/index.ts',
    'bin/limina': 'bin/limina.js',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external: isPackageExternal,
  plugins: [
    cleanDistPlugin(),
    jsoncParserEsmPlugin(),
    packagePlugin(),
    licensePlugin(
      path.resolve(packageDir, 'LICENSE.md'),
      'limina license',
      'limina',
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

const dtsConfig: RolldownOptions = defineConfig({
  input: {
    index: 'src/index.ts',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external: isPackageExternal,
  output: {
    dir: 'dist',
  },
  plugins: [
    dts({
      tsconfig: 'tsconfig.lib.json',
      emitDtsOnly: true,
    }),
  ],
});

const rolldownConfig: RolldownOptions[] = [moduleConfig, dtsConfig];

export default rolldownConfig;
