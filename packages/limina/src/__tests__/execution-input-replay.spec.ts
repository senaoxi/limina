import { observeAnalysisRead, readAnalysisInput } from '#utils/analysis-input';
import {
  readPhysicalFileBinding,
  readPhysicalFileIdentity,
} from '#utils/physical-file-identity';
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EpochInputReplay,
  EpochInputs,
} from '../core/analysis-cache/epoch-inputs';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'replay-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  for (const folder of ['a', 'b']) {
    mkdirSync(file(folder));
    writeFileSync(file(folder, 'value.ts'), 'export const value = 1;');
  }
  symlinkSync(file('a'), file('view'), 'junction');
  const target = file('view/value.ts');
  let reads = 0;
  const scopes = Array.from({ length: 3 }, () => {
    const inputs = new EpochInputs();
    inputs.run(() =>
      readAnalysisInput(target, () => {
        reads += 1;
        return readFileSync(target, 'utf8');
      }),
    );
    return inputs;
  });
  return { file, target, scopes, reads: () => reads };
}

it.each(['content', 'binding'] as const)(
  'shares duplicate observations only within a round and rejects later %s drift',
  async (change) => {
    const f = fixture();
    const replay = new EpochInputReplay();
    const before = f.reads();
    for (const scope of f.scopes) await scope.assertStable(undefined, replay);
    expect(f.reads() - before).toBe(1);
    if (change === 'content') {
      const stat = statSync(f.target);
      writeFileSync(f.target, 'export const value = 2;');
      utimesSync(f.target, stat.atime, stat.mtime);
    } else {
      rmSync(f.file('view'));
      symlinkSync(f.file('b'), f.file('view'), 'junction');
    }
    await expect(f.scopes[0]!.assertStable()).rejects.toThrow(/changed|drift/u);
  },
);

it('does not transfer a managed-write exception to a strict scope in the same round', async () => {
  const f = fixture();
  writeFileSync(f.target, 'export const value = 2;');
  const replay = new EpochInputReplay();
  const before = f.reads();
  await f.scopes[0]!.assertStable(new Set([f.target]), replay);
  await expect(f.scopes[1]!.assertStable(undefined, replay)).rejects.toThrow(
    /changed|drift/u,
  );
  expect(f.reads() - before).toBe(1);
});

it('shares restoration observations while retaining each context receipt and later drift checks', async () => {
  const f = fixture();
  const records = f.scopes[0]!.snapshot()!;
  const inputs = new EpochInputs();
  const replay = new EpochInputReplay();
  const read = vi.spyOn(fs, 'readFileSync');
  syncBuiltinESMExports();
  try {
    expect(await inputs.validate(records, replay)).toBe(true);
    const reads = read.mock.calls.length;
    expect(inputs.validateSynchronous(records, replay)).toBe(true);
    expect(read.mock.calls).toHaveLength(reads);
    const altered = records.map((record) => ({
      ...record,
      version: 'omitted-input',
    }));
    expect(inputs.validateSynchronous(altered, replay)).toBe(false);
    expect(inputs.selectRecords(altered)).toBeUndefined();
    const selected = inputs.selectRecords(records)!;
    expect(selected.paths.has(f.target)).toBe(true);
    writeFileSync(f.target, 'export const value = 3;');
    await expect(selected.assertStable()).rejects.toThrow(/changed|drift/u);
  } finally {
    read.mockRestore();
    syncBuiltinESMExports();
  }
});

it('shares one read notification across collectors without reusing its next dispatch', () => {
  const f = fixture();
  const scopes = Array.from({ length: 3 }, () => new EpochInputs());
  const input = {
    path: f.target,
    key: 'shared-content',
    descriptor: { kind: 'content' as const, path: f.target },
    value: readFileSync(f.target, 'utf8'),
    read: () => readFileSync(f.target, 'utf8'),
  };
  const dispatch = () =>
    scopes[0]!.collect(() =>
      scopes[1]!.collect(() =>
        scopes[2]!.collect(() => observeAnalysisRead(input)),
      ),
    );
  const canonical = vi.spyOn(fs.realpathSync, 'native');
  try {
    dispatch();
    expect(
      canonical.mock.calls.filter(([file]) => file === f.target),
    ).toHaveLength(1);
    for (const scope of scopes)
      expect(scope.snapshot()).toEqual(scopes[0]!.snapshot());
    rmSync(f.file('view'));
    symlinkSync(f.file('b'), f.file('view'), 'junction');
    // Reusing the caller's object must still observe its new physical binding.
    expect(dispatch).toThrow(/changed|drift/u);
  } finally {
    canonical.mockRestore();
  }
});

it('reuses bindings within bounded analysis and observes them afresh at stability checks', async () => {
  const f = fixture();
  const inputs = new EpochInputs();
  const canonical = vi.spyOn(fs.realpathSync, 'native');
  try {
    inputs.run(() => {
      for (let index = 0; index < 16; index += 1) {
        readAnalysisInput(f.target, () => readFileSync(f.target, 'utf8'));
        readAnalysisInput(
          f.target,
          () => readPhysicalFileBinding(f.target),
          'file-binding',
        );
      }
    });
    const readsPerRound = process.platform === 'win32' ? 2 : 1;
    expect(canonical.mock.calls).toHaveLength(readsPerRound);
    await expect(inputs.assertStable()).resolves.toBeUndefined();
    expect(canonical.mock.calls).toHaveLength(readsPerRound * 2);
    rmSync(f.file('view'));
    symlinkSync(f.file('b'), f.file('view'), 'junction');
    await expect(inputs.assertStable()).rejects.toThrow(/changed|drift/u);
  } finally {
    canonical.mockRestore();
  }
});

it('shares sibling ancestor reads in one round and reads them again in the next', async () => {
  const f = fixture();
  const inputs = new EpochInputs();
  inputs.run(() => {
    for (let index = 0; index < 32; index += 1) {
      const file = f.file('view', `${index}.ts`);
      writeFileSync(file, 'export const value = 1;');
      readAnalysisInput(file, () => readFileSync(file, 'utf8'));
      readAnalysisInput(
        file,
        () => readPhysicalFileBinding(file),
        'file-binding',
      );
      readAnalysisInput(
        file,
        () => readPhysicalFileIdentity(file),
        'file-identity',
      );
    }
  });
  const probe = vi.spyOn(fs, 'lstatSync');
  const canonical = vi.spyOn(fs.realpathSync, 'native');
  syncBuiltinESMExports();
  const ancestorReads = () =>
    probe.mock.calls.filter(([file]) => file === f.file('view')).length;
  try {
    await inputs.assertStable();
    expect(ancestorReads()).toBe(1);
    if (process.platform !== 'win32')
      expect(canonical.mock.calls.length).toBeLessThan(32);
    await inputs.assertStable();
    expect(ancestorReads()).toBe(2);
    writeFileSync(f.file('replacement.ts'), 'export const value = 1;');
    renameSync(f.file('replacement.ts'), f.file('view/0.ts'));
    await expect(inputs.assertStable()).rejects.toThrow(/changed|drift/u);
  } finally {
    probe.mockRestore();
    canonical.mockRestore();
    syncBuiltinESMExports();
  }
});

it('preserves native canonical spelling and missing-path results in a shared replay', async () => {
  const f = fixture();
  writeFileSync(f.file('a/é.ts'), 'export {};');
  const paths = [
    'view/value.ts',
    'view/VALUE.ts',
    'a/é.ts',
    'a/é.ts',
    'absent.ts',
  ].map((name) => f.file(name));
  paths.push(
    `${f.file('view')}/`,
    `${f.file('view')}/.`,
    f.file('view'),
    `${f.file('a/value.ts')}/../value.ts`,
  );
  const inputs = new EpochInputs();
  inputs.run(() => {
    for (const file of paths) {
      readAnalysisInput(
        file,
        () => readPhysicalFileBinding(file),
        'file-binding',
      );
    }
  });
  await expect(inputs.assertStable()).resolves.toBeUndefined();
  expect(await new EpochInputs().validate(inputs.snapshot()!)).toBe(true);
});
