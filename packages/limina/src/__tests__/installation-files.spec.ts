import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { emptyMetrics } from '../core/analysis-cache/cache-metrics';
import {
  AnalysisInputDriftError,
  type InputDependency,
} from '../core/analysis-cache/contracts';
import { AnalysisInputs } from '../core/analysis-cache/inputs';
import { readInstallationYaml } from '../core/analysis-cache/installation-files';
import { createFixturePathResolver } from './helpers/path';

vi.mock('yaml', async (original) => {
  const yaml = await original<typeof import('yaml')>();
  return { ...yaml, parse: vi.fn(yaml.parse) };
});

const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(
    path.join(tmpdir(), 'limina-installation-files-'),
  );
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root)('settings.yaml');
  const inputs = new AnalysisInputs({}, emptyMetrics());
  const read = () => {
    const dependencies: InputDependency[] = [];
    return {
      value: readInstallationYaml(file, inputs, dependencies),
      dependencies,
    };
  };
  const write = (text: string) => writeFileSync(file, text);
  return { file, inputs, read, write };
}

describe('installation YAML observations', () => {
  it('parses identical content once while retaining receipts and caller isolation', () => {
    const f = fixture();
    f.write('packageManager: pnpm@12.10.1\nnested: {enabled: true}\n');
    const first = f.read();
    (first.value.nested as Record<string, unknown>).enabled = false;
    const second = f.read();
    expect(second.value.nested).toEqual({ enabled: true });
    expect(second.dependencies).toEqual(first.dependencies);
    expect(
      second.dependencies.map((entry) => f.inputs.records[entry.inputId].kind),
    ).toEqual(['file', 'binding', 'content']);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(() => f.inputs.assertStable()).not.toThrow();
    const independent = new AnalysisInputs({}, emptyMetrics());
    expect(readInstallationYaml(f.file, independent, [])).toEqual(second.value);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('keys parsed values by observed bytes even when the mtime is retained', () => {
    const f = fixture();
    f.write('selected: first\n');
    const before = statSync(f.file);
    expect(f.read().value).toEqual({ selected: 'first' });
    f.write('selected: second\n');
    utimesSync(f.file, before.atime, before.mtime);
    expect(f.read().value).toEqual({ selected: 'second' });
    f.write('selected: first\n');
    utimesSync(f.file, before.atime, before.mtime);
    expect(f.read().value).toEqual({ selected: 'first' });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('rejects changed consumed inputs before reusing a parsed value', () => {
    const f = fixture();
    f.write('selected: first\n');
    const before = statSync(f.file);
    f.inputs.consume(f.read().dependencies);
    f.write('selected: second\n');
    utimesSync(f.file, before.atime, before.mtime);
    expect(f.read).toThrow(AnalysisInputDriftError);
    expect(() => f.inputs.assertStable()).toThrow(AnalysisInputDriftError);
  });

  it('observes deletion and rejects malformed replacement content', () => {
    const f = fixture();
    f.write('selected: first\n');
    expect(f.read().value).toEqual({ selected: 'first' });
    rmSync(f.file);
    expect(f.read().value).toEqual({});
    expect(() => f.inputs.assertStable()).toThrow(AnalysisInputDriftError);
    f.write('selected: [\n');
    expect(f.read).toThrow();
  });
});
