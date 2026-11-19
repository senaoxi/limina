import { readAnalysisInput } from '#utils/analysis-input';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { observeConfigLoad } from '../config/input-observation';
import { ConfigLoadEvidence } from '../config/load-evidence';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import {
  collectFrameworkConfigInputs,
  type FrameworkConfigLoads,
} from '../core/analysis-cache/framework-config-inputs';
import type { GovernedSourceUnit } from '../core/build-graph/types';
import { createSinglePackageFixture } from './helpers/single-package';

vi.mock('../config/input-observation', () => ({ observeConfigLoad: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function svelteSource(root: string): GovernedSourceUnit {
  return {
    configPath: `${root}/tsconfig.json`,
    packageRootDir: root,
    context: { checkerPresets: ['svelte-check'], extensions: ['.svelte'] },
    buildProjection: { kind: 'framework-checker' },
    declarationFileNames: [],
    declarationReferences: new Set(),
    ownedFileNames: [],
    primaryCheckerName: 'svelte-check',
    semanticAuthority: {
      family: 'svelte',
      kind: 'locked',
      source: 'explicit',
    },
    frameworkCapabilities: [
      {
        family: 'svelte',
        packageRootDir: root,
        sourceConfigPath: `${root}/tsconfig.json`,
      },
    ],
  };
}

it.each(['win32', 'posix'] as const)(
  'collects configuration identities independently of the host (%s)',
  async (flavor) => {
    const paths = path[flavor];
    const root =
      flavor === 'win32' ? 'C:/portable-fixture' : '/portable-fixture';
    const first = `${root}/svelte.config.cjs`;
    const second = `${root}/nested/svelte.config.mjs`;
    const nativeFirst = paths.join(root, 'svelte.config.cjs');
    const evidence = new ConfigLoadEvidence('native');
    const loader = vi
      .mocked(observeConfigLoad)
      .mockResolvedValue({ value: {}, inputs: evidence.inputs, evidence });
    vi.spyOn(ts.sys, 'readDirectory').mockReturnValue([
      nativeFirst,
      first,
      second,
    ]);
    vi.spyOn(ts.sys, 'fileExists').mockImplementation(
      (file) => file.replaceAll('\\', '/') === first,
    );
    const inputs = new EpochInputs();
    inputs.collect(() =>
      readAnalysisInput(
        `${root}/src/App.svelte`,
        () => '',
        'typescript-content',
      ),
    );
    const source = svelteSource(root);
    const loads: FrameworkConfigLoads = new Map();
    await collectFrameworkConfigInputs({ source, inputs, loads });
    expect(loader.mock.calls.map(([file]) => file)).toEqual([first, second]);
    await collectFrameworkConfigInputs({ source, inputs, loads });
    expect(loader).toHaveBeenCalledTimes(2);
    vi.mocked(ts.sys.readDirectory).mockReturnValue([]);
    vi.mocked(ts.sys.fileExists).mockReturnValue(false);
    await collectFrameworkConfigInputs({
      source,
      inputs: new EpochInputs(),
      loads: new Map(),
    });
    expect(loader).toHaveBeenCalledTimes(2);
    vi.mocked(ts.sys.readDirectory).mockReturnValue([first]);
    evidence.unknown.add('unobserved-source');
    await expect(
      collectFrameworkConfigInputs({
        source,
        inputs: new EpochInputs(),
        loads: new Map(),
      }),
    ).rejects.toThrow('unobserved-source');
  },
);

it('replays passive config bytes and keeps executable Svelte configuration live', async () => {
  const actual = await vi.importActual<
    typeof import('../config/input-observation')
  >('../config/input-observation');
  vi.mocked(observeConfigLoad).mockImplementation(actual.observeConfigLoad);
  const name = 'svelte.config.cjs';
  const fixture = await createSinglePackageFixture({
    [name]: 'module.exports = {};',
  });
  const collect = async (root: string) => {
    const source = svelteSource(root);
    const graph = new EpochInputs();
    const execution = new EpochInputs();
    await graph.run(() =>
      collectFrameworkConfigInputs({
        source,
        inputs: execution,
        loads: new Map(),
      }),
    );
    return { graph, execution };
  };
  try {
    const passive = await collect(fixture.rootDir);
    const records = passive.graph.snapshot();
    expect(records).toBeDefined();
    expect(await new EpochInputs().validate(records!)).toBe(true);
    await passive.execution.assertStable();

    const code =
      'require("node:fs").writeFileSync(__dirname + "/executed", "loaded"); module.exports = {};';
    await fixture.write(name, code);
    expect(await new EpochInputs().validate(records!)).toBe(false);
    await expect(passive.execution.assertStable()).rejects.toThrow();

    // The native loader intentionally refuses to re-evaluate a preloaded CJS entry.
    const second = await createSinglePackageFixture({ [name]: code });
    try {
      const executable = await collect(second.rootDir);
      expect(await readFile(second.path('executed'), 'utf8')).toBe('loaded');
      expect(executable.graph.snapshot()).toBeUndefined();
      await executable.execution.assertStable();
    } finally {
      await second.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});
