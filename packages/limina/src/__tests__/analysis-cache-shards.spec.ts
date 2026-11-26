import { readAnalysisInput } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  AnalysisObserver,
  runWithProfile,
} from '../application/analysis/observability';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import {
  packAnalysisRecord,
  unpackAnalysisRecord,
} from '../core/analysis-cache/record-payload';
import {
  packRecordTable,
  unpackRecordTable,
} from '../core/analysis-cache/record-table';
import { emptySnapshot } from '../core/analysis-cache/snapshot-records';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  ANALYSIS_STORAGE,
  analysisBlockDigest,
  type AnalysisSnapshotIndex,
  encodeAnalysisBlocks,
  readAnalysisBlocks,
} from '../core/analysis-cache/snapshot-shards';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import {
  analysisBlockPath,
  readStoredAnalysisSnapshot,
} from './helpers/analysis-snapshot';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('encodes repeated private evidence within a bounded heap', () => {
  const encoder = new URL(
    '../core/analysis-cache/snapshot-receipts.ts',
    import.meta.url,
  ).href;
  const publication = new URL(
    '../domain/analysis/native-evidence-freeze.ts',
    import.meta.url,
  ).href;
  const script = `
    import { encodeAnalysisRecords, decodeAnalysisRecords } from ${JSON.stringify(encoder)};
    import { freezeNativeData } from ${JSON.stringify(publication)};
    const proof = freezeNativeData({
      dependencies: [{ inputId: 'proof-input', expectedVersion: 'proof-version' }],
      queryIds: ['proof-query', 'proof-query'],
      members: Array.from({ length: 1024 }, (_, index) => ({
        lexicalPath: '/fixture/source-' + index + '.ts',
        physical: { state: 'verified', inputVersion: 'version-' + index },
      })),
    });
    const records = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [
      'context-' + index,
      { proof, dependencies: [{ inputId: 'input', expectedVersion: 'version-' + index }] },
    ]));
    const encoded = encodeAnalysisRecords({ contexts: records });
    const restored = decodeAnalysisRecords({
      ...encoded,
      contexts: { first: encoded.contexts['context-0'], last: encoded.contexts['context-1999'] },
    });
    console.log(JSON.stringify({
      count: Object.keys(encoded.contexts).length,
      first: restored.contexts.first.proof.members[0],
      last: restored.contexts.last.proof.members.at(-1),
      proofDependencies: restored.contexts.first.proof.dependencies,
      proofQueries: restored.contexts.last.proof.queryIds,
      versions: [restored.contexts.first, restored.contexts.last].map(record => record.dependencies[0].expectedVersion),
    }));
  `;
  expect(runWithBoundedHeap(script, 128)).toEqual({
    count: 2000,
    first: {
      lexicalPath: '/fixture/source-0.ts',
      physical: { state: 'verified', inputVersion: 'version-0' },
    },
    last: {
      lexicalPath: '/fixture/source-1023.ts',
      physical: { state: 'verified', inputVersion: 'version-1023' },
    },
    proofDependencies: [
      { inputId: 'proof-input', expectedVersion: 'proof-version' },
    ],
    proofQueries: ['proof-query', 'proof-query'],
    versions: ['version-0', 'version-1999'],
  });
});

it('packs repeated scope references within a bounded heap', () => {
  const packer = new URL(
    '../core/analysis-cache/shared-record-table.ts',
    import.meta.url,
  ).href;
  const reader = new URL(
    '../core/analysis-cache/record-table.ts',
    import.meta.url,
  ).href;
  const script = `
    import { packSharedRecordTables } from ${JSON.stringify(packer)};
    import { unpackRecordTable } from ${JSON.stringify(reader)};
    const values = ['left', 'right'].map(scope => Array.from(
      { length: 1500 },
      (_, index) => [...Array(2048).fill('common'), scope + '-' + index],
    ));
    const packed = packSharedRecordTables(values);
    const shared = unpackRecordTable(packed.shared);
    const decoded = packed.tables.map(table => unpackRecordTable(table, shared));
    console.log(JSON.stringify({
      rows: decoded.map(value => value.length),
      first: decoded[0][0].at(-1),
      last: decoded[1].at(-1).at(-1),
      repeated: decoded[1][0].slice(0, 2),
      width: decoded[1][0].length,
    }));
  `;
  expect(runWithBoundedHeap(script, 256)).toEqual({
    rows: [1500, 1500],
    first: 'left-0',
    last: 'right-1499',
    repeated: ['common', 'common'],
    width: 2049,
  });
});

function runWithBoundedHeap(script: string, megabytes: number): unknown {
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${megabytes}`,
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it('rejects incompatible storage and graph blocks before opening the generation', () => {
  const f = fixture();
  const snapshot = records(f.file);
  const encoded = [...encodeAnalysisBlocks(snapshot)];
  const contents = new Map(
    encoded.map((item) => [item.reference.digest, Buffer.from(item.text)]),
  );
  const blocks = encoded.map((item) => item.reference);
  const index = {
    header: snapshot.header,
    configModules: snapshot.configModules,
    storage: { version: ANALYSIS_STORAGE, blocks },
  };
  const current = parseAnalysisSnapshot(
    readAnalysisBlocks(index, (block) => contents.get(block.digest)!),
    'fixture',
  );
  expect(current?.contexts).toEqual(snapshot.contexts);
  for (const key of [
    'graphs',
    'contributions',
    'authorities',
    'resolvedConfigs',
  ])
    expect(current).not.toHaveProperty(key);
  const legacy = {
    ...index,
    storage: {
      ...index.storage,
      blocks: [...blocks, { ...blocks[0], kind: 'graph', scope: 'legacy' }],
    },
  };
  for (const obsolete of [
    legacy,
    { ...index, storage: { ...index.storage, version: 4 } },
  ]) {
    let reads = 0;
    expect(() =>
      readAnalysisBlocks(obsolete, (block) => {
        reads += 1;
        return contents.get(block.digest)!;
      }),
    ).toThrow();
    expect(reads).toBe(0);
  }
});

it.each([
  'length',
  'receipt-block',
  'receipt-input',
  'expected-version',
  'obsolete-group',
  'record-reference',
  'shared-reference',
  'duplicate-key',
] as const)(
  'rejects %s corruption inside a correctly hashed scope envelope',
  (fault) => {
    const f = fixture();
    const snapshot = records(f.file);
    const encoded = [...encodeAnalysisBlocks(snapshot)];
    const target = encoded.find(
      (block) => block.reference.scope === f.file('a', 'tsconfig.json'),
    )!;
    const block = JSON.parse(target.text);
    const sharedBlock = encoded.find((item) => item.reference.kind === 'pool')!;
    const sharedPayload = unpackAnalysisRecord(
      JSON.parse(sharedBlock.text).payload,
    );
    const shared = unpackRecordTable(sharedPayload) as readonly unknown[];
    if (fault === 'length') block.payload.byteLength += 1;
    else if (
      ['duplicate-key', 'record-reference', 'shared-reference'].includes(fault)
    ) {
      const table = unpackAnalysisRecord(block.payload) as {
        entries: unknown[];
        root: number;
      };
      if (fault === 'duplicate-key')
        table.entries.push(['object', '__proto__', false, '__proto__', null]);
      else
        table.root =
          fault === 'record-reference'
            ? Number.MAX_SAFE_INTEGER
            : Number.MIN_SAFE_INTEGER;
      block.payload = packAnalysisRecord(table, 'json', 'brotli');
    } else {
      const payload = structuredClone(
        unpackRecordTable(unpackAnalysisRecord(block.payload), shared),
      ) as {
        graphs?: Record<string, unknown>;
        queries: Record<string, { dependencies: unknown }>;
        receiptEncoding: {
          dependencies: { inputId: unknown; expectedVersion: string }[];
        };
      };
      switch (fault) {
        case 'receipt-block': {
          payload.queries['source-0']!.dependencies = {
            receiptBlocks: [Number.MAX_SAFE_INTEGER],
          };
          break;
        }
        case 'receipt-input': {
          payload.receiptEncoding.dependencies[0]!.inputId = 1;
          break;
        }
        case 'obsolete-group': {
          payload.graphs = { legacy: {} };
          break;
        }
        case 'expected-version': {
          payload.receiptEncoding.dependencies[0]!.expectedVersion = 'stale';
          break;
        }
      }
      block.payload = packAnalysisRecord(
        packRecordTable(payload),
        'json',
        'brotli',
      );
    }
    target.text = JSON.stringify(block);
    target.reference.digest = analysisBlockDigest(target.text);
    target.reference.bytes = Buffer.byteLength(target.text);
    const contents = new Map(
      encoded.map((item) => [item.reference.digest, Buffer.from(item.text)]),
    );
    const read = () =>
      readAnalysisBlocks(
        {
          header: snapshot.header,
          configModules: snapshot.configModules,
          storage: {
            version: ANALYSIS_STORAGE,
            blocks: encoded.map((item) => item.reference),
          },
        },
        (item) => contents.get(item.digest)!,
      );
    if (fault === 'expected-version')
      expect(parseAnalysisSnapshot(read(), 'fixture')).toBeUndefined();
    else expect(read).toThrow();
  },
);
function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-shards-'));
  const rootDirectory = realpathSync.native(temporary);
  roots.push(rootDirectory);
  const file = createFixturePathResolver(rootDirectory);
  writeFileSync(
    file('package.json'),
    '{"name":"fixture","private":true,"type":"module"}',
  );
  writeFileSync(file('limina.config.mjs'), 'export default {};');
  const namespace = createLiminaArtifactNamespace({
    rootDir: rootDirectory,
    generation: 0,
  });
  const options = {
    namespace,
    identity: 'fixture',
    configPath: file('limina.config.mjs'),
    configVersion: 'fixture-config',
  };
  const cache = () =>
    new NativeAnalysisCache('fixture', undefined, {
      configVersion: 'fixture-config',
    });
  return { file, options, cache };
}
function records(file: (...segments: string[]) => string): AnalysisSnapshot {
  const snapshot = emptySnapshot('fixture', 'fixture-config');
  const dependencies = Array.from({ length: 1025 }, (_, index) => {
    const inputId = `input-${index}`;
    const expectedVersion = `version-${index}`;
    snapshot.inputs[inputId] = {
      path: file('input', String(index)),
      kind: 'content',
      version: expectedVersion,
    };
    return { inputId, expectedVersion };
  });
  for (const [id, configPath] of [
    ['source', file('a', 'tsconfig.json')],
    ['declaration', file('b', 'tsconfig.dts.json')],
  ]) {
    snapshot.projects[id] = {
      roots: [],
      members: [],
      environment: [],
      references: [],
    };
    snapshot.contexts[id] = {
      project: {
        configPath,
        fileNames: [],
        options: {},
        admissionMode: 'full-program',
        analysisBinding: { phase: 'locked', checker: 'tsc' },
      },
      environment: {
        policy: 'physical-type-roots-v1',
        effectiveTypeRoots: [],
        typeRootsHash: 'empty',
        dependencies: [],
        evidence: 'observed',
      },
      sharedEnvironment: { dependencies: [], queryIds: [], version: 'empty' },
      dependencies: [],
      queryIds: [],
      boundary: [],
      sources: {},
      typeEntries: [],
      complete: true,
    };
    for (let index = 0; index < 40; index++) {
      const query = `${id}-${index}`;
      snapshot.queries[query] = {
        contextId: id,
        file: file(id, `${index}.ts`),
        request: ['module', 'fixture'],
        result: {},
        dependencies: [...dependencies, dependencies[index]!],
        coverage: 'complete',
      };
      snapshot.contexts[id]!.queryIds.push(query);
    }
  }
  return snapshot;
}
it('keeps scope payloads independent and losslessly shares long receipt sequences', () => {
  const f = fixture();
  const snapshot = records(f.file);
  const encoded = [...encodeAnalysisBlocks(snapshot)];
  expect(
    encoded
      .filter((block) => block.reference.kind === 'facts')
      .map((block) => block.reference.scope)
      .filter((scope) => scope !== null)
      .sort(compareCodeUnits),
  ).toEqual([f.file('a', 'tsconfig.json'), f.file('b', 'tsconfig.dts.json')]);
  const index = {
    header: snapshot.header,
    configModules: snapshot.configModules,
    storage: {
      version: ANALYSIS_STORAGE,
      blocks: encoded.map((block) => block.reference),
    },
  };
  const contents = new Map(
    encoded.map((block) => [block.reference.digest, Buffer.from(block.text)]),
  );
  expect(
    readAnalysisBlocks(index, (block) => contents.get(block.digest)!),
  ).toEqual(snapshot);
  const restored = parseAnalysisSnapshot(
    readAnalysisBlocks(index, (block) => contents.get(block.digest)!),
    'fixture',
  );
  expect(restored).toBeDefined();
  expect(
    [...encodeAnalysisBlocks(restored!)].map((block) => block.reference),
  ).toEqual(encoded.map((block) => block.reference));
  const originalSize = Buffer.byteLength(JSON.stringify(snapshot));
  expect(
    encoded.reduce((sum, block) => sum + block.reference.bytes, 0),
  ).toBeLessThan(originalSize / 10);
  snapshot.queries['source-0']!.request = ['module', 'changed'];
  const changed = [...encodeAnalysisBlocks(snapshot)];
  for (const block of changed) {
    const prior = encoded.find(
      (item) => item.reference.scope === block.reference.scope,
    )!;
    if (block.reference.scope === f.file('a', 'tsconfig.json'))
      expect(block.reference.digest).not.toBe(prior.reference.digest);
    else expect(block.reference.digest).toBe(prior.reference.digest);
  }
});

it.each(['missing', 'corrupt', 'traversal'] as const)(
  'rejects a %s block after a positive restoration control',
  async (fault) => {
    const f = fixture();
    const store = new AnalysisCacheStore(f.options);
    store.read();
    await store.publish(f.cache());
    expect(
      parseAnalysisSnapshot(readStoredAnalysisSnapshot(store.path), 'fixture'),
    ).toBeDefined();
    const index = JSON.parse(
      readFileSync(store.path, 'utf8'),
    ) as AnalysisSnapshotIndex;
    const block = index.storage.blocks[0]!;
    const target = analysisBlockPath(store.path, block);
    switch (fault) {
      case 'missing': {
        rmSync(target);
        break;
      }
      case 'corrupt': {
        writeFileSync(target, '{corrupt');
        break;
      }
      case 'traversal': {
        block.digest = '../../outside';
        writeFileSync(store.path, JSON.stringify(index));
        break;
      }
    }
    expect(() => readStoredAnalysisSnapshot(store.path)).toThrow();
    const cold = new AnalysisCacheStore(f.options);
    expect(cold.read()).toBeUndefined();
    await cold.publish(f.cache());
    expect(
      parseAnalysisSnapshot(readStoredAnalysisSnapshot(store.path), 'fixture'),
    ).toBeDefined();
  },
);

it('publishes the index last and preserves shared block bytes on a forced refresh', async () => {
  const f = fixture();
  const store = new AnalysisCacheStore(f.options);
  store.read();
  await store.publish(f.cache());
  const before = readFileSync(store.path);
  const index = JSON.parse(before.toString()) as AnalysisSnapshotIndex;
  const target = analysisBlockPath(
    store.path,
    index.storage.blocks.find((block) => block.scope === null)!,
  );
  const bytes = readFileSync(target);
  const mtime = statSync(target).mtimeMs;
  const forced = new AnalysisCacheStore(f.options);
  const observer = new AnalysisObserver('forced-cache', performance.now());
  await runWithProfile(observer, async () => {
    expect(forced.read({ restore: false })).toBeUndefined();
    await forced.publish(f.cache());
  });
  expect(readFileSync(store.path)).not.toEqual(before);
  expect(readFileSync(target)).toEqual(bytes);
  expect(statSync(target).mtimeMs).toBe(mtime);
  const metrics = new Map(
    observer.snapshot().metrics.map(({ key, value }) => [key, value]),
  );
  const blockSizes = index.storage.blocks.map(
    (block) => statSync(analysisBlockPath(store.path, block)).size,
  );
  expect(metrics.get('snapshot.read-bytes.bytes')).toBe(before.length);
  expect(metrics.get('snapshot.check-baseline.calls')).toBe(2);
  expect(metrics.get('snapshot.check-baseline.bytes')).toBe(2 * before.length);
  expect(metrics.get('snapshot.check-block.calls')).toBe(blockSizes.length);
  expect(metrics.get('snapshot.check-block.bytes')).toBe(
    blockSizes.reduce((total, size) => total + size, 0),
  );
  expect(metrics.has('snapshot.read-block.calls')).toBe(false);
  expect(metrics.has('snapshot.write-block.calls')).toBe(false);
  expect(metrics.get('snapshot.write-index.calls')).toBe(1);
  expect(metrics.get('snapshot.write-index.bytes')).toBe(
    statSync(store.path).size,
  );
  expect(metrics.get('snapshot.write.calls')).toBe(1);
  const stable = readFileSync(store.path);
  const failing = new AnalysisCacheStore(f.options);
  failing.read({ restore: false });
  const cache = f.cache();
  mkdirSync(f.file('input'));
  writeFileSync(f.file('input', 'file'), 'before');
  const file = f.file('input', 'file');
  const discovery = f.file('workspace.json');
  writeFileSync(discovery, '{"projects":["input"]}');
  cache.epoch.run(() => {
    readAnalysisInput(
      file,
      () => cache.inputs.sourceDigest(file),
      'source-digest',
    );
    readAnalysisInput(discovery, () => readFileSync(discovery, 'utf8'));
  });
  const originalBlocks = readdirSync(path.dirname(target)).length;
  await expect(
    failing.publish(cache, () => {
      if (readdirSync(path.dirname(target)).length > originalBlocks)
        writeFileSync(discovery, '{"projects":["input", "new"]}');
      return cache.epoch.assertStable();
    }),
  ).rejects.toThrow(`Analysis input changed during analysis: ${discovery}`);
  expect(readFileSync(store.path)).toEqual(stable);
  expect(
    parseAnalysisSnapshot(readStoredAnalysisSnapshot(store.path), 'fixture'),
  ).toBeDefined();
});
