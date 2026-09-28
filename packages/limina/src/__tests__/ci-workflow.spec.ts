import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
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
  strategy?: {
    matrix?: {
      include?: { os: string; node: string | number }[];
      node?: string[];
    };
  };
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

describe('Limina CI validation contract', () => {
  it('runs core gates for every root, fixture, tooling, and configuration change', async () => {
    const value = await workflow();
    expect(value.on.push).not.toHaveProperty('paths');
    expect(value.on.pull_request).not.toHaveProperty('paths');
    for (const name of [
      'build-artifacts',
      'quality',
      'test',
      'build',
      'limina-platform-build-smoke',
      'limina-atomic-writer-windows',
    ]) {
      expect(value.jobs[name]).toBeDefined();
      expect(value.jobs[name].if).toBeUndefined();
    }
  });
  it('builds bootstrap tools before product artifacts and uses read-only quality commands', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toBe(
      'pnpm run build:tools && pnpm --filter limina run build && pnpm --filter limina-migrate run build',
    );
    expect(manifest.scripts['build:tools']).toBe(
      'pnpm --filter @limina/build-tools run build && pnpm --filter @limina/eslint-config run build',
    );
    const quality = await readFile(
      path.join(root, '.github/actions/build-and-check/action.yml'),
      'utf8',
    );
    for (const command of [
      'build',
      'format:check',
      'lint:check',
      'typecheck',
      'check',
      'lint:packages',
    ])
      expect(quality).toContain(`pnpm run ${command}`);
    expect(manifest.scripts['lint:check']).not.toContain('--fix');
    expect(manifest.scripts['format:check']).toContain('--check');
  });
  it('waits for all validation jobs and rejects failure, cancellation and skipped gates', async () => {
    const { jobs } = await workflow();
    expect(jobs.status.needs?.toSorted()).toEqual(
      Object.keys(jobs)
        .filter((name) => name !== 'status')
        .toSorted(),
    );
    expect(jobs.status.if).toBe('always()');
    const check = jobs.status.steps?.find(
      (step) => step.name === 'Check Status',
    );
    for (const outcome of ['failure', 'cancelled', 'skipped'])
      expect(check?.env?.FAILED).toContain(
        `contains(needs.*.result, '${outcome}')`,
      );
    expect(check?.run).toContain('exit 1');
  });
  it('retains independent platform builds and the supported Node test matrix', async () => {
    const { jobs } = await workflow();
    expect(jobs.test.strategy?.matrix?.include).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ os: 'ubuntu-latest', node: '22.18.0' }),
        expect.objectContaining({ os: 'ubuntu-latest', node: '24.11.0' }),
        expect.objectContaining({ os: 'ubuntu-latest', node: 24 }),
        expect.objectContaining({ os: 'macos-latest', node: '22.18.0' }),
        expect.objectContaining({ os: 'windows-latest', node: '22.18.0' }),
      ]),
    );
    expect(
      jobs['limina-platform-build-smoke'].strategy?.matrix?.include,
    ).toHaveLength(4);
    expect(jobs['limina-atomic-writer-windows'].strategy?.matrix?.node).toEqual(
      ['22.18.0', '24.11.0'],
    );
  });
  it('runs the isolated Vue semantic matrix against built and installed artifacts', async () => {
    const { jobs } = await workflow();
    const matrix = jobs['limina-vue-semantic-matrix'];
    expect(matrix.needs).toEqual(['build-artifacts']);
    expect(
      jobs['build-artifacts'].steps?.find(
        (step) => step.with?.name === 'packages-build-artifacts',
      )?.with?.path,
    ).toBe('packages/*/dist/**');
    expect(
      matrix.steps?.find((step) =>
        step.uses?.startsWith('actions/download-artifact@'),
      )?.with,
    ).toEqual({ name: 'packages-build-artifacts', path: 'packages' });
    const commands = matrix.steps?.map((step) => step.run);
    expect(commands).toContain(
      'pnpm --dir packages/limina/fixtures/vue-semantic-matrix install --frozen-lockfile --ignore-scripts',
    );
    expect(commands).toContain(
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
