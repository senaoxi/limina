import { loadConfig } from '#config/runner';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createDefaultExecutionPlan } from '../pipeline/plan';

interface Step {
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string[];
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
async function workflow(): Promise<Workflow> {
  return parse(
    await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
  ) as Workflow;
}
describe('Limina CI product validation entry points', () => {
  it('builds bootstrap tools before product artifacts and uses read-only quality commands', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toBe(
      'pnpm run build:tools && pnpm --filter limina run build && pnpm --filter limina-migrate run build',
    );
    expect(manifest.scripts['build:tools']).toBe(
      'pnpm --filter @limina/gates run build && pnpm --filter @limina/build-tools run build',
    );
    const quality = await readFile(
      path.join(root, '.github/actions/build-and-check/action.yml'),
      'utf8',
    );
    for (const command of [
      'build',
      'gates:check',
      'format:check',
      'lint:check',
      'check',
      'lint:packages',
    ])
      expect(quality).toContain(`pnpm run ${command}`);
    const config = await loadConfig({
      configLoader: 'tsx',
      configPath: path.join(root, 'limina.config.mts'),
      cwd: root,
    });
    expect(quality).not.toContain('pnpm run typecheck');
    expect(
      createDefaultExecutionPlan(config)
        .tasks.filter((task) => task.kind === 'task')
        .map((task) => task.issueTask),
    ).toEqual([
      'graph:check',
      'source:check',
      'proof:check',
      'checker:build',
      'checker:typecheck',
    ]);
    for (const [script, pipeline, tool, requiredFlag, forbiddenFlag] of [
      ['format:check', 'format', 'prettier', '--check', '--write'],
      ['lint:check', 'lint', 'eslint', '--config', '--fix'],
    ] as const) {
      expect(manifest.scripts[script]).toBe(`limina check ${pipeline}`);
      const step = config.pipelines?.[pipeline]?.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate.type === 'command' &&
          candidate.command === tool,
      );
      if (typeof step !== 'object' || step.type !== 'command')
        throw new Error(`Missing ${tool} command in ${pipeline}.`);
      expect(step.args).toContain('.');
      expect(step.args).toContain(requiredFlag);
      expect(step.args).not.toContain(forbiddenFlag);
    }
  });
  it('keeps product verification behind native artifact admission', async () => {
    const { jobs } = await workflow();
    expect(jobs['repository-gates'].needs).toEqual(['plan']);
    expect(jobs['native-build'].needs).toEqual(['plan']);
    for (const name of [
      'limina-unit',
      'validation',
      'platform-smoke',
      'windows-behavior',
      'vue-compatibility',
      'docs',
    ]) {
      const job = jobs[name];
      expect(
        job.steps?.some((step) => step.run?.includes('artifact-restore')),
      ).toBe(true);
      expect(job.steps?.some((step) => step.run === 'pnpm run build')).toBe(
        false,
      );
    }
    const commands = jobs.validation.steps?.map((step) => step.run).join('\n');
    for (const command of [
      'pnpm run check',
      'pnpm run lint:packages',
      'pnpm run test:tooling',
      'pnpm --filter limina-migrate run test:unit',
      'pnpm --filter limina run test:integration',
      'pnpm --filter limina-migrate run test:integration',
    ])
      expect(commands).toContain(command);
    expect(
      jobs['platform-smoke'].steps?.find((step) => step.id === 'smoke')?.run,
    ).toBe('pnpm run test:smoke');
  });
  it('runs Vue semantic checks against the installed consumer', async () => {
    const { jobs } = await workflow();
    const command = jobs['vue-compatibility'].steps?.find(
      (step) => step.id === 'vue_matrix',
    )?.run;
    expect(command).toContain('install --frozen-lockfile --ignore-scripts');
    expect(command).toContain(
      'pnpm --dir packages/limina/fixtures/vue-semantic-matrix matrix',
    );
    const runner = await readFile(
      path.join(
        root,
        'packages/limina/fixtures/vue-semantic-matrix/run-matrix.mjs',
      ),
      'utf8',
    );
    expect(runner).toContain("requireFromCase.resolve('limina/package.json')");
    expect(runner).toContain('installed.liminaCli');
    expect(runner).not.toContain("new URL('../../dist/bin/limina.js'");
    expect(runner).not.toContain("new URL('../../bin/limina.js'");
  });
});

it('selects portable evidence and real framework admission in the Windows focused job', async () => {
  const job = (await workflow()).jobs['windows-behavior'];
  const commands = job.steps?.map((step) => step.run ?? '').join('\n');
  for (const file of [
    'path.spec.ts',
    'framework-config-inputs.spec.ts',
    'type-evidence.spec.ts',
    'execution-admission.spec.ts',
  ])
    expect(commands).toContain(`src/__tests__/${file}`);
  expect(commands).toContain('binds framework execution to consumed inputs');
  expect(commands).toContain(
    'retains live CommonJS configuration proof through managed refresh in Node',
  );
});
