import { expect } from 'vitest';
import type { GeneratedDependencyEdge } from '../../core/build-graph/types';

export type ConditionalReferenceMode = 'require' | 'import';

export const conditionalProviders = {
  require: { config: 'tsconfig.cjs.json', source: 'cjs/index.ts' },
  import: { config: 'tsconfig.esm.json', source: 'esm/index.mts' },
} as const;

export function conditionalReferenceFiles(
  modes: readonly ConditionalReferenceMode[],
): Record<string, string> {
  const imports = modes.map(
    (mode) =>
      `import type Value_${mode} from 'pkg' with { 'resolution-mode': '${mode}' };`,
  );
  const exports = modes.map(
    (mode) =>
      `export const value_${mode}: typeof Value_${mode} = '${mode === 'require' ? 'cjs' : 'esm'}';`,
  );
  const compilerOptions = {
    composite: true,
    strict: true,
    types: [],
    lib: ['es5'],
  };
  const providerOptions = {
    ...compilerOptions,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
  };
  const packageIdentity = { name: 'pkg', version: '1.0.0' };
  return {
    'package.json': JSON.stringify({
      ...packageIdentity,
      private: true,
      type: 'commonjs',
      packageManager: 'npm@11.6.1',
      exports: {
        '.': { require: './cjs/index.js', import: './esm/index.mjs' },
      },
    }),
    'package-lock.json': JSON.stringify({
      ...packageIdentity,
      lockfileVersion: 3,
      packages: { '': packageIdentity },
    }),
    'limina.config.mjs':
      'export default {cache:true, scope:{checkers:{tsc:{include:["tsconfig.json"]}}}};',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        { path: './app/tsconfig.json' },
        { path: './tsconfig.cjs.json' },
        { path: './tsconfig.esm.json' },
      ],
    }),
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        module: 'Preserve',
        moduleResolution: 'Bundler',
      },
      files: ['index.ts'],
    }),
    'app/index.ts': [...imports, ...exports, ''].join('\n'),
    'tsconfig.cjs.json': JSON.stringify({
      compilerOptions: providerOptions,
      files: ['cjs/index.ts'],
    }),
    'tsconfig.esm.json': JSON.stringify({
      compilerOptions: providerOptions,
      files: ['esm/index.mts'],
    }),
    'cjs/index.ts': "const value = 'cjs' as const; export = value;\n",
    'esm/index.mts': "const value = 'esm' as const; export default value;\n",
  };
}

export function expectConditionalReferenceEdges(
  edges: readonly GeneratedDependencyEdge[],
  file: (name: string) => string,
  modes: readonly ConditionalReferenceMode[],
): void {
  expect(edges.map((edge) => edge.fromConfigPath)).toEqual(
    modes.map(() => file('app/tsconfig.json')),
  );
  expect(
    edges
      .map(
        (edge) =>
          [
            Number(/^app\/index\.ts:(\d+) \(/.exec(edge.file)?.[1]),
            edge.importedSpecifier,
            edge.resolvedFilePath,
            edge.toConfigPath,
            edge.kind,
          ] as const,
      )
      .sort((a, b) => a[0] - b[0]),
  ).toEqual(
    modes.map((mode, index) => [
      index + 1,
      'pkg',
      file(conditionalProviders[mode].source),
      file(conditionalProviders[mode].config),
      'declaration-provider',
    ]),
  );
}
