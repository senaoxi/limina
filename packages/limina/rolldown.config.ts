import licensePlugin from '@docs-islands/plugin-license';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { defineConfig, type RolldownOptions } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';
import packagePlugin from './packagePlugin';

const external = [/^[\w@][^:]/, /^node:/];
const packageDir = fileURLToPath(new URL('.', import.meta.url));

const moduleConfig: RolldownOptions = defineConfig({
  input: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    config: 'src/config.ts',
    'bin/limina': 'bin/limina.js',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external,
  plugins: [
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
    config: 'src/config.ts',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external,
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
