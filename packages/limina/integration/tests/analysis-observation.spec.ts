import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';
import { createSemanticRepairFixture } from '../../src/__tests__/helpers/semantic-repair';
import { runLimina } from '../helpers/run-limina';

const milestone = z.object({
  gate: z.enum(['core', 'preflight']),
  atUs: z.number().nonnegative(),
});
const projectRecord = z.object({ id: z.string(), path: z.string() });
const graphRecord = z.object({
  purpose: z.string(),
  source: z.string().optional(),
  prepared: z.array(milestone).optional(),
});
const decisionRecord = z.object({
  layer: z.string(),
  stage: z.string(),
  outcome: z.string(),
  origin: z.string().optional(),
});
const projectRow = z.object({
  project: z.string(),
  state: z.string(),
  workUnionUs: z.number().nonnegative().nullable(),
});
const profileSchema = z.object({
  schemaVersion: z.literal(2),
  invocation: z.object({
    id: z.string(),
    result: z.enum(['passed', 'failed']),
    commandInvocationUs: z.number().positive(),
  }),
  projects: z.array(projectRecord),
  graphs: z.array(graphRecord),
  decisions: z.array(decisionRecord),
  summary: z.object({
    mode: z.string(),
    projectRows: z.array(projectRow),
    firstCompleteGraphPrepared: milestone.nullable(),
    firstCompleteReceiptCommittedUs: z.number().nonnegative().nullable(),
  }),
});

const probeSecret = 'LIMINA_PROFILE_INTEGRATION_SECRET_93D303';

async function fixture() {
  const f = await createSemanticRepairFixture({
    'package.json':
      '{"name":"observation-fixture","private":true,"type":"module","packageManager":"npm@11.6.1"}',
    'package-lock.json':
      '{"name":"observation-fixture","lockfileVersion":3,"packages":{"":{}}}',
    'limina.config.mjs': [
      '// LIMINA_PROFILE_PRIVATE_CONFIG_TEXT',
      'export default { scope: { checkers: { tsc: { include: ["tsconfig.json"] } } }, pipelines: { probe: ["graph:check"] } };',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        noLib: true,
        types: [],
        module: 'NodeNext',
        outDir: 'dist',
      },
      include: ['src/**/*.ts'],
    }),
    'src/main.ts': 'export const LIMINA_PROFILE_PRIVATE_SOURCE_TEXT = 1;',
  });
  const outputRoot = await mkdtemp(
    path.join(tmpdir(), 'limina-observation-output-'),
  );
  return {
    ...f,
    output: createFixturePathResolver(outputRoot),
    async cleanup() {
      await Promise.all([
        f.cleanup(),
        rm(outputRoot, { recursive: true, force: true }),
      ]);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function run(
  f: Fixture,
  commandArguments: string[],
  profileEnvironment = '0',
) {
  const result = await runLimina({
    fixtureName: 'analysis-observation',
    cwd: f.root,
    args: commandArguments,
    env: {
      LIMINA_PROFILE: profileEnvironment,
      LIMINA_PROFILE_BUILD_INPUT_HASH: undefined,
      LIMINA_PROFILE_EXPECTED_EXECUTABLE_REALPATH: undefined,
      LIMINA_PROFILE_EXPECTED_PACKAGE_REALPATH: undefined,
      LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH: undefined,
      NODE_OPTIONS: '',
      PROFILE_TEST_SECRET: probeSecret,
    },
  });
  expect(result.timedOut, result.stdout + result.stderr).toBe(false);
  return result;
}

async function onlyProfile(f: Fixture, output: string) {
  const files = await readdir(output);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/\.json$/u);
  const raw = await readFile(path.join(output, files[0]!), 'utf8');
  expect(raw).not.toContain(f.path());
  expect(raw).not.toContain(probeSecret);
  expect(raw).not.toContain('LIMINA_PROFILE_PRIVATE_CONFIG_TEXT');
  expect(raw).not.toContain('LIMINA_PROFILE_PRIVATE_SOURCE_TEXT');
  const profile = profileSchema.parse(JSON.parse(raw));
  expect(files[0]).toBe(`${profile.invocation.id}.json`);
  return profile;
}

async function cacheIndex(f: Fixture) {
  const directory = f.path('.limina', 'cache');
  const index = (await readdir(directory, { recursive: true })).find((entry) =>
    entry.endsWith('index.liminainfo'),
  );
  expect(index).toBeDefined();
  return f.path('.limina', 'cache', index!);
}

it('records separate prepared and receipt milestones for cold and warm graph preparation', async () => {
  const f = await fixture();
  try {
    let snapshot: { bytes: Buffer; mtimeMs: number } | undefined;
    for (const mode of ['cold', 'warm'] as const) {
      const output = f.output(`profiles-${mode}`);
      const result = await run(f, [
        'graph',
        'prepare',
        '--profile-output',
        output,
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const profile = await onlyProfile(f, output);
      expect(profile.invocation.result).toBe('passed');
      expect(profile.summary.mode).toBe(mode);
      expect(profile.projects).toEqual([
        expect.objectContaining({ path: 'tsconfig.json' }),
      ]);
      expect(profile.graphs).toContainEqual(
        expect.objectContaining({
          purpose: 'complete',
          source: mode === 'cold' ? 'computed' : 'restored',
        }),
      );
      const prepared = profile.summary.firstCompleteGraphPrepared;
      const receipt = profile.summary.firstCompleteReceiptCommittedUs;
      expect(prepared?.gate).toBe('preflight');
      expect(receipt).not.toBeNull();
      expect(receipt).toBeGreaterThanOrEqual(prepared!.atUs);
      expect(receipt).toBeLessThanOrEqual(
        profile.invocation.commandInvocationUs,
      );
      expect(profile.summary.projectRows).toEqual([
        expect.objectContaining({
          project: profile.projects[0]!.id,
          state: mode === 'cold' ? 'rebuilt' : 'restored',
          workUnionUs: expect.any(Number),
        }),
      ]);
      const index = await cacheIndex(f);
      const current = {
        bytes: await readFile(index),
        mtimeMs: (await stat(index)).mtimeMs,
      };
      if (mode === 'cold') snapshot = current;
      else expect(current).toEqual(snapshot);
    }
    expect(
      (await onlyProfile(f, f.output('profiles-cold'))).decisions,
    ).toContainEqual(
      expect.objectContaining({
        layer: 'analysis-snapshot',
        stage: 'lookup',
        outcome: 'absent',
      }),
    );
    expect(
      (await onlyProfile(f, f.output('profiles-warm'))).decisions,
    ).toContainEqual(
      expect.objectContaining({
        layer: 'analysis-graph',
        stage: 'adoption',
        outcome: 'adopted',
        origin: 'prior-disk',
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it('gives graph export a Core milestone and preserves stdout and a warm cache', async () => {
  const f = await fixture();
  try {
    const seed = await run(f, ['graph', 'prepare']);
    expect(seed.code, seed.stdout + seed.stderr).toBe(0);
    const index = await cacheIndex(f);
    const cache = await readFile(index);
    const control = await run(f, ['graph', 'export', '--view', 'source']);
    const profiled = await run(f, [
      'graph',
      'export',
      '--view',
      'source',
      '--profile',
    ]);
    expect(control.code, control.stdout + control.stderr).toBe(0);
    expect(profiled.code, profiled.stdout + profiled.stderr).toBe(0);
    const graph: unknown = JSON.parse(profiled.stdout);
    expect(graph).toMatchObject({ view: 'source' });
    expect(profiled.stdout).toBe(control.stdout);
    expect(await readFile(index)).toEqual(cache);
    const profile = await onlyProfile(f, f.path('.limina', 'profiles'));
    expect(profile.summary.firstCompleteGraphPrepared?.gate).toBe('core');
    expect(profile.summary.firstCompleteReceiptCommittedUs).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('preserves an early config failure even if the profile destination fails', async () => {
  const f = await fixture();
  try {
    const collision = f.output('blocked-output');
    await writeFile(collision, probeSecret);
    await writeFile(
      f.path('limina.config.mjs'),
      'throw new Error("fixture config execution failed");',
    );
    const control = await run(f, ['check', 'probe']);
    const profiled = await run(f, [
      'check',
      'probe',
      '--profile-output',
      f.output('failure-profile'),
    ]);
    const unableToWrite = await run(f, [
      'check',
      'probe',
      '--profile-output',
      collision,
    ]);
    expect(control.code).toBe(1);
    for (const result of [control, profiled, unableToWrite]) {
      expect(result.code).toBe(control.code);
      expect(result.stdout).toBe(control.stdout);
      expect(result.stderr).toContain('fixture config execution failed');
    }
    expect(unableToWrite.stderr).toMatch(
      /could not write the analysis profile/iu,
    );
    expect(await readFile(collision, 'utf8')).toBe(probeSecret);
    const profile = await onlyProfile(f, f.output('failure-profile'));
    expect(profile.invocation.result).toBe('failed');
    expect(profile.projects).toEqual([]);
    expect(profile.summary.firstCompleteGraphPrepared).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('retains the quiet legacy check profile alongside the versioned invocation report', async () => {
  const f = await fixture();
  try {
    const result = await run(f, ['check', 'probe'], '1');
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain('Limina Analysis Profile');
    const legacy: unknown = JSON.parse(
      await readFile(f.path('.limina', 'check', 'last-profile.json'), 'utf8'),
    );
    expect(legacy).toMatchObject({
      schemaVersion: 1,
      metrics: expect.any(Array),
    });
    const profile = await onlyProfile(f, f.path('.limina', 'profiles'));
    expect(profile.invocation.result).toBe('passed');
  } finally {
    await f.cleanup();
  }
});
