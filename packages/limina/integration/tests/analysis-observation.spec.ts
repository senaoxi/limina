import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFixturePathResolver,
  toPortableRelativePath,
} from '../../src/__tests__/helpers/path';
import { createSemanticRepairFixture } from '../../src/__tests__/helpers/semantic-repair';
import { runLimina, type RunLiminaOptions } from '../helpers/run-limina';

const milestone = z.object({
  gate: z.enum(['core', 'preflight']),
  atUs: z.number().nonnegative(),
});
const projectRecord = z.object({ id: z.string(), path: z.string() });
const contextRecord = z.object({
  id: z.string(),
  project: z.string(),
  provider: z.string(),
  role: z.string(),
});
const graphRecord = z.object({
  id: z.string(),
  purpose: z.string(),
  source: z.string().optional(),
  prepared: z.array(milestone).optional(),
  result: z.string().optional(),
  requestAtUs: z.number().nonnegative().optional(),
  deliveredAtUs: z.number().nonnegative().optional(),
  requestGate: z.enum(['core', 'preflight', 'applied', 'receipt']).optional(),
  applied: z.object({ atUs: z.number().nonnegative() }).optional(),
});
const decisionRecord = z.object({
  layer: z.string(),
  stage: z.string(),
  outcome: z.string(),
  origin: z.string().optional(),
  subject: z.string().optional(),
});
const projectRow = z.object({
  project: z.string(),
  state: z.string(),
  workUnionUs: z.number().nonnegative().nullable(),
});
const contextRow = z.object({
  context: z.string(),
  state: z.string(),
  workUnionUs: z.number().nonnegative().nullable(),
});
const graphRow = z.object({
  graph: z.string(),
  requestDeliveryUs: z.number().nonnegative().nullable(),
  artifactsApplyElapsedUs: z.number().nonnegative().nullable(),
});
const workRecord = z.object({
  op: z.string(),
  scope: z.array(z.string()),
  end: z.string(),
  reason: z.string().optional(),
  time: z
    .tuple([z.number().nonnegative(), z.number().nonnegative()])
    .optional(),
});
const profileSchema = z.object({
  schemaVersion: z.literal(2),
  invocation: z.object({
    id: z.string(),
    result: z.enum(['passed', 'failed']),
    commandInvocationUs: z.number().positive(),
  }),
  projects: z.array(projectRecord),
  contexts: z.array(contextRecord),
  graphs: z.array(graphRecord),
  decisions: z.array(decisionRecord),
  work: z.array(workRecord),
  summary: z.object({
    mode: z.string(),
    projectRows: z.array(projectRow),
    contextRows: z.array(contextRow),
    graphRows: z.array(graphRow),
    firstCompleteGraphPrepared: milestone.nullable(),
    firstCompleteReceiptCommittedUs: z.number().nonnegative().nullable(),
  }),
});

const probeSecret = 'LIMINA_PROFILE_INTEGRATION_SECRET_93D303';

async function fixture(overrides: Record<string, string> = {}) {
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
    ...overrides,
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

const sourceEntry = {
  executable: process.execPath,
  args: [fileURLToPath(new URL('../../bin/limina.js', import.meta.url))],
};

async function linkVueToolchain(f: Fixture) {
  const require = createRequire(import.meta.url);
  await mkdir(f.path('node_modules'));
  for (const name of ['typescript', 'vue', 'vue-tsc']) {
    const installed = path.dirname(require.resolve(`${name}/package.json`));
    await symlink(
      await realpath(installed),
      f.path('node_modules', name),
      'junction',
    );
  }
}

async function run(
  f: Fixture,
  commandArguments: string[],
  profileEnvironment = '0',
  entry?: RunLiminaOptions['entry'],
) {
  const result = await runLimina({
    fixtureName: 'analysis-observation',
    cwd: f.root,
    args: commandArguments,
    entry,
    env: {
      LIMINA_PROFILE: profileEnvironment,
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

type Profile = Awaited<ReturnType<typeof onlyProfile>>;

function sourceConfigProjection(profile: Profile, sourceConfig: string) {
  return profile.decisions.filter(
    (decision) =>
      decision.layer === 'resolved-config-projection' &&
      decision.stage === 'adoption' &&
      decision.outcome === 'adopted' &&
      decision.origin === 'prior-disk' &&
      decision.subject === sourceConfig,
  );
}

function liveSourceConfigParses(profile: Profile, sourceConfig: string) {
  const project = profile.projects.find(({ path }) => path === sourceConfig);
  expect(project).toBeDefined();
  return profile.work.filter(
    (work) =>
      work.op === 'source-config.live-parse' &&
      work.scope[0] === 'project' &&
      work.scope[1] === project?.id,
  );
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
      expect(result.stderr).toContain(`Analysis cache: ${mode}`);
      expect(result.stderr).toMatch(
        /^ {2}\[info\] Complete graph prepared at (?:<1ms|\d+ms|\d+\.\d{2}s) /mu,
      );
      expect(result.stderr).toContain('timed profile.* spans only');
      expect(result.stderr).toContain('final report generation and output');
      const profile = await onlyProfile(f, output);
      expect(profile.invocation.result).toBe('passed');
      expect(profile.summary.mode).toBe(mode);
      expect(profile.projects).toEqual([
        expect.objectContaining({ path: 'tsconfig.json' }),
      ]);
      expect(profile.graphs).toContainEqual(
        expect.objectContaining({
          purpose: 'complete',
          source: 'computed',
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
      const applied = profile.graphs.find(
        (graph) => graph.applied !== undefined,
      );
      const applyElapsed = profile.summary.graphRows.find(
        (row) => row.graph === applied?.id,
      )?.artifactsApplyElapsedUs;
      expect(applyElapsed).toBeGreaterThanOrEqual(0);
      expect(applyElapsed).toBeLessThanOrEqual(
        (applied?.applied?.atUs ?? 0) - prepared!.atUs,
      );
      const request = profile.graphs.find(
        (graph) =>
          graph.result === applied?.id && graph.requestGate === 'receipt',
      );
      expect(request?.deliveredAtUs).toBeGreaterThanOrEqual(receipt!);
      expect(
        profile.summary.graphRows.find((row) => row.graph === request?.id),
      ).toMatchObject({
        requestDeliveryUs: request!.deliveredAtUs! - request!.requestAtUs!,
      });
      expect(profile.summary.projectRows).toEqual([
        expect.objectContaining({
          project: profile.projects[0]!.id,
          state: mode === 'cold' ? 'rebuilt' : 'restored',
          workUnionUs: expect.any(Number),
        }),
      ]);
      const contexts = profile.contexts.filter(
        ({ provider, role }) =>
          provider === 'typescript' && ['pending', 'locked'].includes(role),
      );
      expect(contexts.map(({ role }) => role)).toEqual(['locked']);
      const liveSourceParses = profile.work.filter(
        (work) =>
          work.op === 'source-config.live-parse' &&
          work.scope[0] === 'project' &&
          work.scope[1] === profile.projects[0]!.id,
      );
      expect(liveSourceParses).toHaveLength(mode === 'cold' ? 1 : 0);
      for (const context of contexts) {
        expect(context.project).toBe(profile.projects[0]!.id);
        expect(
          profile.summary.contextRows.find(
            ({ context: id }) => id === context.id,
          ),
        ).toMatchObject({
          state: mode === 'cold' ? 'rebuilt' : 'restored',
          workUnionUs: expect.any(Number),
        });
        expect(profile.work).toContainEqual(
          expect.objectContaining({
            scope: ['context', context.id],
            op:
              mode === 'cold'
                ? 'native-program-create'
                : 'native-context-restore',
            end: mode === 'cold' ? 'computed' : 'restored',
            time: [expect.any(Number), expect.any(Number)],
          }),
        );
      }
      const lines = result.stderr.split(/\r?\n/u);
      const projectLine = lines.findIndex((line) =>
        line.startsWith('  [info] tsconfig.json · '),
      );
      expect(projectLine).toBeGreaterThanOrEqual(0);
      expect(lines[projectLine + 1]?.split(' · ').at(-1)).toBe(
        mode === 'cold'
          ? 'Cache cause context-record-absent'
          : 'Cache cause prior-disk',
      );
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
        layer: 'native-context',
        stage: 'adoption',
        outcome: 'adopted',
        origin: 'prior-disk',
        subject: 'tsconfig.json',
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it('reports a cold cache and the cause of a failed graph preparation in the default check', async () => {
  const f = await fixture({
    'limina.config.mjs':
      'export default { scope: { checkers: { "vue-tsc": { include: ["tsconfig.json"] } } } };',
    'src/Example.vue':
      '<script setup lang="ts">import "./main.js";</script><template><div /></template>',
  });
  try {
    const output = f.output('failed-preparation');
    const result = await run(f, ['check', '--profile-output', output]);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const reportStart = result.stderr.indexOf('Limina Analysis Profile');
    expect(reportStart).toBeGreaterThanOrEqual(0);
    const report = result.stderr.slice(reportStart);
    expect(report).toContain('Analysis cache: cold');
    expect(report).toMatch(
      /^ {2}\[fail\] Graph preparation \(core\) failed after (?:<1ms|\d+ms|\d+\.\d{2}s)$/mu,
    );
    expect(report).toContain('Missing external checker');
    expect(report).toContain('vue-tsc');
    const profile = await onlyProfile(f, output);
    expect(profile.summary.firstCompleteGraphPrepared).toBeNull();
    expect(profile.summary.firstCompleteReceiptCommittedUs).toBeNull();
    expect(profile.work).toContainEqual(
      expect.objectContaining({
        op: 'graph.materialize',
        end: 'failed',
        reason: 'materialization-failed',
      }),
    );
    expect(
      profile.work.some((work) => work.op === 'graph.apply.artifacts'),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it('attributes Vue output projection work and cache adoption to the source project', async () => {
  const f = await fixture({
    'limina.config.mjs':
      'export default {scope:{checkers:{"vue-tsc":{include:["tsconfig.json"]}}}};',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        target: 'ES2022',
        noLib: true,
        types: [],
      },
      include: ['src/**/*.ts'],
      liminaOptions: {
        outputs: { target: 'ES2020', rootDir: 'src', outDir: 'output' },
      },
    }),
    'src/main.ts': 'export {value} from "./value.js";',
    'src/value.ts': 'export const value = 1;',
  });
  try {
    await linkVueToolchain(f);
    const prepare = async (mode: 'cold' | 'warm') => {
      const destination = f.output(mode);
      const result = await run(
        f,
        ['graph', 'prepare', '--profile-output', destination],
        '0',
        sourceEntry,
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const profile = await onlyProfile(f, destination);
      expect(profile.summary.mode).toBe(mode);
      expect(profile.projects.map((project) => project.path)).toEqual([
        'tsconfig.json',
      ]);
      return profile;
    };

    const cold = await prepare('cold');
    const warm = await prepare('warm');
    expect(liveSourceConfigParses(cold, 'tsconfig.json')).toHaveLength(1);
    expect(liveSourceConfigParses(warm, 'tsconfig.json')).toHaveLength(0);
    expect(sourceConfigProjection(warm, 'tsconfig.json')).toHaveLength(1);
    const restoredContexts = warm.contexts.filter(({ id }) =>
      warm.summary.contextRows.some(
        ({ context, state }) => context === id && state === 'restored',
      ),
    );
    for (const role of ['graph', 'output-projection']) {
      expect(cold.contexts).toContainEqual(
        expect.objectContaining({
          project: cold.projects[0]!.id,
          provider: 'vue',
          role,
        }),
      );
      expect(restoredContexts).toContainEqual(
        expect.objectContaining({
          project: warm.projects[0]!.id,
          provider: 'vue',
          role,
        }),
      );
    }
    const adopted = warm.decisions.filter(
      (decision) =>
        decision.layer === 'vue-context' &&
        decision.outcome === 'adopted' &&
        decision.origin === 'prior-disk',
    );
    expect(adopted.length).toBeGreaterThanOrEqual(2);
    expect(new Set(adopted.map((decision) => decision.subject))).toEqual(
      new Set(['tsconfig.json']),
    );
  } finally {
    await f.cleanup();
  }
});

const vueBaseConfig = (extension: string) =>
  JSON.stringify({ vueCompilerOptions: { extensions: ['.vue', extension] } });
const vueBaseConfigWithByte = (byte: number) =>
  Buffer.concat([
    Buffer.from(`${vueBaseConfig('.widget')}\n// `),
    Buffer.from([byte]),
  ]);

it.each([
  {
    change: 'an inherited extension edit',
    before: Buffer.from(vueBaseConfig('.widget')),
    after: Buffer.from(vueBaseConfig('.hidden')),
    expectedRoots: ['src/main.ts'],
  },
  {
    change: 'an inherited raw-byte edit with equivalent decoded text',
    before: vueBaseConfigWithByte(0x80),
    after: vueBaseConfigWithByte(0x81),
    expectedRoots: ['src/Comp.widget', 'src/main.ts'],
  },
])(
  'rejects a warm Vue Source Config parse after $change with equal size and mtime',
  async (scenario) => {
    const source = 'tsconfig.json';
    const f = await fixture({
      'limina.config.mjs':
        'export default {scope:{source:{include:["src/**/*"]},checkers:{"vue-tsc":{include:["tsconfig.json"]}}},pipelines:{probe:["graph:prepare"]}};',
      [source]: JSON.stringify({
        extends: './base.json',
        compilerOptions: { noLib: true, types: [], module: 'NodeNext' },
        include: ['src/**/*'],
      }),
      'src/Comp.widget': '<template>custom extension</template>',
    });
    const sourceToDts = z.record(z.string(), z.string());
    const vueChecker = z.object({ sourceToDts });
    const manifest = z.object({
      checkers: z.object({ 'vue-tsc': vueChecker }),
    });
    const generated = z.object({ files: z.array(z.string()) });
    try {
      await linkVueToolchain(f);
      const parentConfig = f.path('base.json');
      await writeFile(parentConfig, scenario.before);
      await utimes(parentConfig, 1000, 1000);
      const initial = await stat(parentConfig);
      const prepare = async (stage: string, extra: string[] = []) => {
        const output = f.output(stage);
        const result = await run(
          f,
          ['check', 'probe', ...extra, '--profile-output', output],
          '0',
          sourceEntry,
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const profile = await onlyProfile(f, output);
        const graphText = await readFile(
          f.path('.limina', 'manifest.json'),
          'utf8',
        );
        const graph = manifest.parse(JSON.parse(graphText));
        const declaration = f.path(
          graph.checkers['vue-tsc'].sourceToDts[source]!,
        );
        const declarationText = await readFile(declaration, 'utf8');
        const roots = generated
          .parse(JSON.parse(declarationText))
          .files.map((file) =>
            toPortableRelativePath(
              f.root,
              path.resolve(path.dirname(declaration), file),
            ),
          );
        return { profile, graphText, declarationText, roots };
      };

      const cold = await prepare('cold');
      expect(liveSourceConfigParses(cold.profile, source)).toHaveLength(1);
      expect(cold.roots).toEqual(['src/Comp.widget', 'src/main.ts']);
      const warm = await prepare('warm');
      expect(sourceConfigProjection(warm.profile, source)).toHaveLength(1);
      expect(liveSourceConfigParses(warm.profile, source)).toHaveLength(0);
      expect(warm.declarationText).toBe(cold.declarationText);

      await writeFile(parentConfig, scenario.after);
      await utimes(parentConfig, 1000, 1000);
      const current = await stat(parentConfig);
      expect(current.size).toBe(initial.size);
      expect(current.mtimeMs).toBe(initial.mtimeMs);
      const changed = await prepare('changed');
      expect(sourceConfigProjection(changed.profile, source)).toHaveLength(0);
      expect(liveSourceConfigParses(changed.profile, source)).toHaveLength(1);
      expect(changed.roots).toEqual(scenario.expectedRoots);

      const forced = await prepare('forced', ['--force']);
      expect(sourceConfigProjection(forced.profile, source)).toHaveLength(0);
      expect(liveSourceConfigParses(forced.profile, source)).toHaveLength(1);
      expect(forced.graphText).toBe(changed.graphText);
      expect(forced.declarationText).toBe(changed.declarationText);
    } finally {
      await f.cleanup();
    }
  },
);

it('keeps the Preflight milestone when graph check later reads the prepared Core result', async () => {
  const f = await fixture();
  try {
    const output = f.output('graph-check-profile');
    const result = await run(f, ['graph', 'check', '--profile-output', output]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const profile = await onlyProfile(f, output);
    const coreRequest = profile.graphs.find(
      (graph) => graph.requestGate === 'core',
    );
    const canonical = profile.graphs.find(
      (graph) => graph.id === coreRequest?.result,
    );
    const preflight = canonical?.prepared?.find(
      (mark) => mark.gate === 'preflight',
    );
    expect(coreRequest?.requestAtUs).toBeGreaterThanOrEqual(
      preflight?.atUs ?? Infinity,
    );
    expect(coreRequest).toMatchObject({
      source: 'shared',
      deliveredAtUs: expect.any(Number),
    });
    expect(profile.summary.firstCompleteGraphPrepared).toEqual(preflight);
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

it.each([
  {
    scenario: 'an inline switch value that names a configured pipeline',
    args: ['check', '--profile=probe'],
    explicitOutput: true,
    diagnostic: '--profile does not take a value.',
  },
  {
    scenario: 'a repeated profiling switch',
    args: ['check', '--profile', '--profile'],
    explicitOutput: true,
    diagnostic: '--profile does not take a value.',
  },
  {
    scenario: 'an empty output directory',
    args: ['check', '--profile-output', ''],
    explicitOutput: false,
    diagnostic: '--profile-output requires a directory.',
  },
  {
    scenario: 'a missing output directory',
    args: ['graph', 'prepare', '--profile-output'],
    explicitOutput: false,
    diagnostic: '--profile-output requires a directory.',
  },
  {
    scenario: 'a malformed profiling switch on the command help error path',
    args: ['check', '--help', '--unknown', '--profile', '--profile'],
    explicitOutput: true,
    diagnostic: 'Unknown option `--unknown`',
  },
])('rejects $scenario without starting profiling', async (testCase) => {
  const f = await fixture();
  try {
    const output = f.output('profiles');
    const commandArguments = testCase.explicitOutput
      ? [...testCase.args, '--profile-output', output]
      : testCase.args;
    const result = await run(f, commandArguments);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(testCase.diagnostic);
    expect(result.stderr).not.toContain('Limina Analysis Profile');
    expect(result.stderr).not.toContain('could not write the analysis profile');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.path('.limina'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await f.cleanup();
  }
});

it('captures a command help error with a valid explicit profiling destination', async () => {
  const f = await fixture();
  try {
    const output = f.output('profiles');
    const result = await run(f, [
      'check',
      '--help',
      '--unknown',
      '--profile-output',
      output,
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unknown option `--unknown`');
    expect(result.stderr).toMatch(
      /^ {2}\[fail\] Command failed after (?:<1ms|\d+ms|\d+\.\d{2}s)\r?\n {4}\[info\] Reason: Unknown option/mu,
    );
    expect((await onlyProfile(f, output)).invocation.result).toBe('failed');
    await expect(stat(f.path('.limina'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
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

it('writes one performance report when enabled by the environment', async () => {
  const f = await fixture();
  try {
    const result = await run(f, ['check', 'probe'], '1');
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain('Limina Analysis Profile');
    await expect(
      stat(f.path('.limina', 'check', 'last-profile.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const profile = await onlyProfile(f, f.path('.limina', 'profiles'));
    expect(profile.invocation.result).toBe('passed');
  } finally {
    await f.cleanup();
  }
});
