import { bench, describe } from 'vitest';
import { decodeData, encodeData } from '../src/core/analysis-cache/data-codec';
import { collectTypeScriptSourceTextImports } from '../src/core/import-analysis/typescript-imports';
import { nativeFingerprint } from '../src/core/typescript-semantic/native-file-identity';
import { freezeNativeData } from '../src/domain/analysis/native-evidence-freeze';
import { collectStronglyConnectedComponents } from '../src/utils/strongly-connected-components';

// Built from parts so Limina's own source scan does not read the generated
// JSDoc import type in this file as a dependency of the benchmark.
const jsdocImport = 'import';

function createModuleSource(seed: number): string {
  const lines = [
    "import ts from 'typescript';",
    "import type { Plugin } from 'vite';",
    "import { readFile } from 'node:fs/promises';",
    "import * as path from 'node:path';",
    `import { helper${seed} } from '@scope/shared-${seed % 7}';`,
    "export { defineConfig } from './config';",
    "export type { Options } from './options';",
    '/// <reference types="node" />',
  ];
  for (let index = 0; index < 40; index++) {
    lines.push(
      `import { value${index} } from '../feature-${index}/index';`,
      `/** @see {@link ${jsdocImport}('./types-${index}').Shape${index}} */`,
      `export async function load${index}(name: string): Promise<unknown> {`,
      `  const module = await import(\`./locales/\${name}-${index}.json\`);`,
      `  const fallback = await import('./fallback-${index}');`,
      `  return { module, fallback, value: value${index}, helper: helper${seed} };`,
      '}',
      `const legacy${index} = require('legacy-${index % 5}');`,
    );
  }
  lines.push('export const version = ts.version + path.sep + readFile.name;');
  return `${lines.join('\n')}\n`;
}

const moduleSources = Array.from({ length: 8 }, (_, index) => ({
  filePath: `/workspace/packages/app/src/module-${index}.ts`,
  sourceText: createModuleSource(index),
}));

// Mirrors the [path, text] pairs fingerprinted as a context source version.
const sourceInputs = Array.from({ length: 64 }, (_, index) => [
  `/workspace/packages/pkg-${index % 8}/src/module-${index}.ts`,
  createModuleSource(index),
]);

function createEvidenceRecord(size: number): Record<string, unknown> {
  return {
    version: 1,
    project: '/workspace/packages/app/tsconfig.lib.json',
    files: Array.from({ length: size }, (_, index) => ({
      fileName: `/workspace/packages/app/src/module-${index}.ts`,
      identity: { size: 1024 + index, version: `v${index}` },
      requests: Array.from({ length: 6 }, (_, request) => ({
        specifier: `../feature-${request}/index`,
        resolvedFileName: `/workspace/packages/app/feature-${request}/index.ts`,
        mode: request % 2 === 0 ? 99 : 1,
        isExternal: false,
        range: { start: request * 40, end: request * 40 + 24 },
      })),
      roots: [`module-${index}`],
    })),
    options: {
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      paths: { '#utils/*': ['./src/utils/*.ts'] },
    },
  };
}

const evidenceRecord = createEvidenceRecord(200);
const encodedEvidence = encodeData(evidenceRecord);

// Layered project graph with a back edge every 25 nodes to form cycles.
const graphNodes = Array.from(
  { length: 2000 },
  (_, index) => `project-${index}`,
);
const graphEdges = new Map(
  graphNodes.map((node, index) => {
    const neighbors: string[] = [];
    for (const offset of [1, 2, 7]) {
      const target = graphNodes[index + offset];
      if (target !== undefined) neighbors.push(target);
    }
    if (index % 25 === 24) neighbors.push(graphNodes[index - 20]!);
    return [node, neighbors];
  }),
);

describe('source analysis', () => {
  bench('collect TypeScript source imports', () => {
    for (const source of moduleSources)
      collectTypeScriptSourceTextImports(source);
  });

  bench('fingerprint context source inputs', () => {
    nativeFingerprint(sourceInputs);
  });
});

describe('analysis data', () => {
  bench('freeze native evidence data', () => {
    freezeNativeData(evidenceRecord);
  });

  bench('encode analysis cache data', () => {
    encodeData(evidenceRecord);
  });

  bench('decode analysis cache data', () => {
    decodeData(encodedEvidence);
  });

  bench('collect strongly connected components', () => {
    collectStronglyConnectedComponents(
      graphNodes,
      (node) => graphEdges.get(node) ?? [],
    );
  });
});
