import { readAnalysisInput } from '#utils/analysis-input';
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

it('shares sibling ancestor reads in one round and reads them again in the next', async () => {
  const f = fixture();
  const inputs = new EpochInputs();
  inputs.run(() => {
    for (let index = 0; index < 32; index += 1) {
      const file = f.file('view', `${index}.ts`);
      writeFileSync(file, 'export const value = 1;');
      readAnalysisInput(file, () => readFileSync(file, 'utf8'));
    }
  });
  const probe = vi.spyOn(fs, 'lstatSync');
  syncBuiltinESMExports();
  const ancestorReads = () =>
    probe.mock.calls.filter(([file]) => file === f.file('view')).length;
  try {
    await inputs.assertStable();
    expect(ancestorReads()).toBe(1);
    await inputs.assertStable();
    expect(ancestorReads()).toBe(2);
  } finally {
    probe.mockRestore();
    syncBuiltinESMExports();
  }
});
