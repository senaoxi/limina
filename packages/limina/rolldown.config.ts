import licensePlugin from '@limina/build-tools/license';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { defineConfig, type RolldownOptions } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';
import package_ from './package.json' with { type: 'json' };
import packagePlugin from './packagePlugin';

const packageDirectory = fileURLToPath(new URL('.', import.meta.url));
const distributionState = { hasCleaned: false };
const packageExternalDependencies = [
  ...Object.keys(package_.dependencies || {}),
  ...Object.keys(package_.peerDependencies || {}),
  // @ts-expect-error No type checking is needed here.
  ...Object.keys(package_.optionalDependencies ?? {}),
];

function isPackageExternal(id: string): boolean {
  return packageExternalDependencies.some(
    (dependencyName) =>
      id === dependencyName || id.startsWith(`${dependencyName}/`),
  );
}

const cleanDistributionPlugin = (): NonNullable<
  RolldownOptions['plugins']
> => ({
  name: 'rolldown-plugin-clean-dist',
  async buildStart() {
    if (distributionState.hasCleaned) {
      return;
    }

    distributionState.hasCleaned = true;
    await rm(path.resolve(packageDirectory, 'dist'), {
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
    cleanDistributionPlugin(),
    packagePlugin(),
    licensePlugin(
      path.resolve(packageDirectory, 'LICENSE.md'),
      'limina license',
      'limina',
      path.resolve(packageDirectory, '../../LICENSE'),
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
