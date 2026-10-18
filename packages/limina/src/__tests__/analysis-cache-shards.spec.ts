import { compareCodeUnits } from '#utils/collections';
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
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import {
  packAnalysisRecord,
  unpackAnalysisRecord,
} from '../core/analysis-cache/record-payload';
import { emptySnapshot } from '../core/analysis-cache/snapshot-records';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
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

it.each([
  'length',
  'receipt-block',
  'receipt-input',
  'expected-version',
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
    if (fault === 'length') block.payload.byteLength += 1;
    else {
      const payload = unpackAnalysisRecord(block.payload) as {
        queries: Record<string, { dependencies: unknown }>;
        receiptEncoding: {
          dependencies: { inputId: unknown; expectedVersion: string }[];
        };
      };
      if (fault === 'receipt-block')
        payload.queries['source-0']!.dependencies = {
          receiptBlocks: [Number.MAX_SAFE_INTEGER],
        };
      else if (fault === 'receipt-input')
        payload.receiptEncoding.dependencies[0]!.inputId = 1;
      else payload.receiptEncoding.dependencies[0]!.expectedVersion = 'stale';
      block.payload = packAnalysisRecord(payload, 'json', 'brotli');
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
            version: 1,
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
        policy: 'lockfile-and-local-roots-v1',
        effectiveTypeRoots: [],
        typeRootsHash: 'empty',
        domains: [],
        dependencies: [],
        evidence: 'observed',
      },
      sharedEnvironment: { dependencies: [], queryIds: [], version: 'empty' },
      dependencies: [],
      queryIds: [],
      boundary: [],
      sources: {},
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
      .map((block) => block.reference.scope)
      .filter((scope) => scope !== null)
      .sort(compareCodeUnits),
  ).toEqual([f.file('a', 'tsconfig.json'), f.file('b', 'tsconfig.dts.json')]);
  const index = {
    header: snapshot.header,
    configModules: snapshot.configModules,
    storage: { version: 1, blocks: encoded.map((block) => block.reference) },
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
  const target = analysisBlockPath(store.path, index.storage.blocks[0]!);
  const bytes = readFileSync(target);
  const mtime = statSync(target).mtimeMs;
  const forced = new AnalysisCacheStore(f.options);
  expect(forced.read({ restore: false })).toBeUndefined();
  await forced.publish(f.cache());
  expect(readFileSync(store.path)).not.toEqual(before);
  expect(readFileSync(target)).toEqual(bytes);
  expect(statSync(target).mtimeMs).toBe(mtime);
  const stable = readFileSync(store.path);
  const failing = new AnalysisCacheStore(f.options);
  failing.read({ restore: false });
  const cache = f.cache();
  mkdirSync(f.file('input'));
  writeFileSync(f.file('input', 'file'), 'before');
  const input = cache.inputs.observe(f.file('input', 'file'), 'content');
  cache.graphs.fixture = {
    workspaceVersion: 'fixture',
    queryIds: [],
    contextIds: [],
    vueContextIds: [],
    dependencies: [input],
    discovery: [],
    data: ['null'],
  };
  const originalBlocks = readdirSync(path.dirname(target)).length;
  await expect(
    failing.publish(cache, () => {
      if (readdirSync(path.dirname(target)).length > originalBlocks)
        throw new Error('publication interrupted');
    }),
  ).rejects.toThrow('publication interrupted');
  expect(readFileSync(store.path)).toEqual(stable);
  expect(
    parseAnalysisSnapshot(readStoredAnalysisSnapshot(store.path), 'fixture'),
  ).toBeDefined();
});
