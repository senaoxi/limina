import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dependencyInputsIdentity, validateMutations } from './mutation.ts';
import { captureSnapshot } from './snapshot.ts';
import type { TaskSpec } from './task.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-mutation-'));
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"example","private":true}',
  );
  await writeFile(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters: {}\n",
  );
  const start = await captureSnapshot(root, 'S0');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
    { path: 'pnpm-lock.yaml', format: 'yaml' },
  ];
  const task: TaskSpec = {
    version: 2,
    id: 'test-dependency-contract',
    split: 'dev',
    domain: 'source-governance',
    prompt: 'Declare the approved dependency.',
    fixtureDigest: 'fixture',
    capturePolicy: { excludedRoots: [], requiredRoots: [] },
    mutationPolicy: {
      protectedRoots: ['protected'],
      rules: [
        {
          path: 'package.json',
          operations: ['modify'],
          jsonFields: [
            '/dependencies/example-dependency',
            '/scripts/build',
            '/scripts/preinstall',
            '/packageManager',
          ],
        },
        { path: 'pnpm-lock.yaml', operations: ['modify'] },
        { path: 'source.ts', operations: ['add', 'modify'] },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'original',
          inputsDigest: dependencyInputsIdentity(start, inputs),
          closureDigest: 'original-closure',
        },
      ],
    },
    installPlan: {
      toolchainDigest: 'toolchain',
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: 'grader',
      requiredAssertions: ['dependency-owner'],
    },
  };
  return { root, start, task };
}

test('authorized dependency and lockfile changes select the pre-admitted closure', async (t) => {
  const { root, start, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    name: 'example',
    private: true,
    dependencies: { 'example-dependency': '1.0.0' },
  };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  '.':\n    dependencies:\n      example-dependency: {specifier: 1.0.0, version: 1.0.0}\n",
  );
  const approved = await captureSnapshot(root, 'S1');
  task.dependencyPolicy.variants.push({
    id: 'approved-dependency',
    inputsDigest: dependencyInputsIdentity(
      approved,
      task.dependencyPolicy.inputs,
    ),
    closureDigest: 'reviewed-closure',
  });
  // Formatting is not a dependency change; semantically identical YAML is valid.
  await writeFile(
    path.join(root, 'pnpm-lock.yaml'),
    "importers: {'.': {dependencies: {example-dependency: {version: 1.0.0, specifier: 1.0.0}}}}\nlockfileVersion: '9.0'\n",
  );
  const decision = validateMutations(
    task,
    start,
    await captureSnapshot(root, 'S1'),
  );
  assert.equal(decision.status, 'accepted');
  if (decision.status !== 'accepted')
    assert.fail('Expected admitted project modification');
  assert.equal(decision.dependencyVariant.closureDigest, 'reviewed-closure');
  assert.deepEqual(
    decision.changes.map((change) => change.path),
    ['package.json', 'pnpm-lock.yaml'],
  );
  // A permitted manifest field is insufficient when its resolution is unapproved.
  manifest.dependencies['example-dependency'] = '2.0.0';
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  const rejected = validateMutations(
    task,
    start,
    await captureSnapshot(root, 'S1'),
  );
  assert.equal(rejected.status, 'unsafe');
  if (rejected.status === 'unsafe')
    assert.deepEqual(
      rejected.violations.map((entry) => entry.code),
      ['dependency_inputs'],
    );
});

test('a writable manifest cannot authorize an installation hook or replace the manager', async (t) => {
  const { root, start, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'sentinel'), 'unchanged');
  // This existing file is part of the baseline, so rejection must target the hook.
  const baseline = await captureSnapshot(root, 'S0');
  for (const change of [
    {
      scripts: {
        preinstall:
          "node -e \"require('fs').writeFileSync('sentinel','executed')\"",
      },
    },
    { packageManager: 'pnpm@0.0.0' },
  ]) {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'example', private: true, ...change }),
    );
    const decision = validateMutations(
      task,
      baseline,
      await captureSnapshot(root, 'S1'),
    );
    assert.equal(decision.status, 'unsafe');
    if (decision.status === 'unsafe')
      assert.deepEqual(
        decision.violations.map((entry) => entry.code),
        ['dependency_inputs'],
      );
    assert.equal(
      await readFile(path.join(root, 'sentinel'), 'utf8'),
      'unchanged',
    );
  }
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"example","private":true,"scripts":{"build":"tsc"}}',
  );
  assert.equal(
    validateMutations(task, baseline, await captureSnapshot(root, 'S1')).status,
    'accepted',
  );
  assert.throws(() =>
    dependencyInputsIdentity(start, [
      { path: '../package.json', format: 'manifest' },
    ]),
  );
});

test('source symlinks and malformed lockfiles do not reach a verifier', async (t) => {
  const { root, start, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink('../outside.ts', path.join(root, 'source.ts'));
  const linkDecision = validateMutations(
    task,
    start,
    await captureSnapshot(root, 'S1'),
  );
  assert.equal(linkDecision.status, 'unsafe');
  if (linkDecision.status === 'unsafe')
    assert.deepEqual(
      linkDecision.violations.map((entry) => entry.code),
      ['file_type'],
    );
  await rm(path.join(root, 'source.ts'));
  await writeFile(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nlockfileVersion: '8.0'\n",
  );
  const lockDecision = validateMutations(
    task,
    start,
    await captureSnapshot(root, 'S1'),
  );
  assert.equal(lockDecision.status, 'unsafe');
  if (lockDecision.status === 'unsafe')
    assert.deepEqual(
      lockDecision.violations.map((entry) => entry.code),
      ['invalid_input'],
    );
  const unknown = {
    ...start,
    stage: 'S1' as const,
    status: 'unknown' as const,
    digest: null,
  };
  assert.equal(validateMutations(task, start, unknown).status, 'unknown');
});

test('manager and project lock documents jointly define the admitted dependency input', async (t) => {
  const { root, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager =
    "lockfileVersion: '9.0'\nimporters: {'.': {packageManagerDependencies: {pnpm: {specifier: 12.10.1, version: 12.10.1}}}}\n";
  const project = "lockfileVersion: '9.0'\nimporters: {'.': {}}\n";
  const lock = path.join(root, 'pnpm-lock.yaml');
  await writeFile(lock, `---\n${manager}---\n${project}`);
  const start = await captureSnapshot(root, 'S0');
  task.dependencyPolicy.variants = [
    {
      id: 'both-documents',
      inputsDigest: dependencyInputsIdentity(
        start,
        task.dependencyPolicy.inputs,
      ),
      closureDigest: 'frozen-closure',
    },
  ];
  await writeFile(
    lock,
    `---\n# Formatting may change\n${manager}---\n${project}`,
  );
  assert.equal(
    validateMutations(task, start, await captureSnapshot(root, 'S1')).status,
    'accepted',
  );
  for (const changed of [
    `---\n${manager.replaceAll('12.10.1', '99.0.0')}---\n${project}`,
    `---\n${manager}---\n${project.replace("{'.': {}}", "{'.': {dependencies: {unapproved: 1.0.0}}}")}`,
    `---\n${manager}---\n${project}---\nignored: must-not-be-ignored\n`,
  ]) {
    await writeFile(lock, changed);
    const result = validateMutations(
      task,
      start,
      await captureSnapshot(root, 'S1'),
    );
    assert.equal(result.status, 'unsafe');
    if (result.status === 'unsafe')
      assert.ok(
        result.violations.some((entry) => entry.code === 'dependency_inputs'),
      );
  }
});

test('data-only config permission rejects executable expressions before verifier admission', async (t) => {
  const { root, start, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  task.mutationPolicy.rules.push({
    path: 'limina.config.mts',
    operations: ['add'],
    content: 'static-limina-config',
  });
  const cases: [string, boolean][] = [
    [
      "import { defineConfig } from 'limina'; export default defineConfig({scope:{checkers:{auto:{exclude:[]}}}});",
      true,
    ],
    [
      "import { defineConfig as config } from 'limina'; export default config({cache:false});",
      true,
    ],
    ['export default {cache:false};', true],
    [
      'export default ({cache:false} satisfies import("limina").LiminaConfig);',
      true,
    ],
    [
      'import type { LiminaConfig } from "limina"; export default {cache:false} satisfies LiminaConfig;',
      true,
    ],
    [
      'import type * as Limina from "limina"; export default {cache:false} satisfies Limina.LiminaConfig;',
      true,
    ],
    [
      'export default {cache:false} satisfies LiminaConfig; import type {LiminaConfig} from "limina";',
      true,
    ],
    [
      'export default ((config satisfies typeof config)({cache:false}) satisfies LiminaConfig); import {defineConfig as config, type LiminaConfig} from "limina";',
      true,
    ],
    [
      'import {defineConfig as config, type LiminaConfig} from "limina"; export default (config(({cache:false} satisfies LiminaConfig)) satisfies LiminaConfig);',
      true,
    ],
    [
      'export default {scope:({checkers:{auto:{exclude:[] satisfies string[]}}} satisfies object)} satisfies import("limina").LiminaConfig;',
      true,
    ],
    [
      "import fs from 'node:fs'; fs.writeFileSync('executed','bad'); export default {};",
      false,
    ],
    ['export default {get cache(){throw new Error("executed")}};', false],
    ['export default {[process.exit()]:true};', false],
    ['export default {...process.env};', false],
    [
      "import { defineConfig } from 'limina'; export default defineConfig((()=>({}))());",
      false,
    ],
    ['export default {__proto__:{}};', false],
    ['export default {cache:false,cache:true};', false],
    ['export default {scope:', false],
    ['export default ((()=>({}))() satisfies object);', false],
    ['export default ({get cache(){return false}} satisfies object);', false],
    ['export default ({...process.env} satisfies object);', false],
    ['export default ({cache:process.exit() satisfies never});', false],
    [
      'import {defineConfig, readConfig} from "limina"; export default defineConfig({}) satisfies object;',
      false,
    ],
    [
      'import * as Limina from "limina"; export default Limina.defineConfig({}) satisfies Limina.LiminaConfig;',
      false,
    ],
    [
      'import type {LiminaConfig} from "limina"; export default (process.exit() satisfies LiminaConfig);',
      false,
    ],
    ['export default ({__proto__:{}} satisfies object);', false],
    ['export default ({cache:false,cache:true} satisfies object);', false],
    ['export default ({} satisfies);', false],
  ];
  for (const [source, accepted] of cases) {
    await writeFile(path.join(root, 'limina.config.mts'), source);
    const final = await captureSnapshot(root, 'S1');
    const decision = validateMutations(task, start, final);
    assert.equal(decision.status, accepted ? 'accepted' : 'unsafe', source);
  }
  await assert.rejects(readFile(path.join(root, 'executed')), {
    code: 'ENOENT',
  });
});

test('pipeline permissions admit ordered arguments but reject command and environment replacement', async (t) => {
  const { root, task } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'limina.config.mts');
  const baseline = { source: { knip: false }, pipelines: { release: [] } };
  await writeFile(config, `export default ${JSON.stringify(baseline)};`);
  const start = await captureSnapshot(root, 'S0');
  task.mutationPolicy.rules.push({
    path: 'limina.config.mts',
    operations: ['modify'],
    content: 'static-limina-config',
    jsonFields: ['/pipelines/release'],
    pipelinePolicy: {
      builtins: ['package:check'],
      commands: [{ command: 'node', argsPrefix: ['scripts/build.mjs'] }],
    },
  });
  const command = {
    type: 'command',
    command: 'node',
    args: ['scripts/build.mjs', 'output with spaces'],
  };
  const cases: [unknown[], boolean][] = [
    [[command, 'package:check'], true],
    [[{ type: 'task', name: 'package:check' }, command], true],
    [['node scripts/build.mjs output with spaces'], true],
    [[{ ...command, command: 'npx' }], false],
    [[{ ...command, args: ['-e', 'process.exit(0)'] }], false],
    [[{ ...command, args: ['scripts/other.mjs'] }], false],
    [[{ ...command, cwd: '../' }], false],
    [
      [{ ...command, env: { NODE_OPTIONS: '--import=./untrusted.mjs' } }],
      false,
    ],
    [[{ type: 'task', name: 'package:check', env: {} }], false],
    [[{ ...command, args: ['scripts/build.mjs', 'bad\0argument'] }], false],
    [['node -e process.exit(0)'], false],
  ];
  for (const [release, accepted] of cases) {
    await writeFile(
      config,
      `import {defineConfig as config} from 'limina'; export default config(${JSON.stringify({ ...baseline, pipelines: { release } })});`,
    );
    const result = validateMutations(
      task,
      start,
      await captureSnapshot(root, 'S1'),
    );
    assert.equal(
      result.status,
      accepted ? 'accepted' : 'unsafe',
      JSON.stringify(release),
    );
  }
  await writeFile(
    config,
    `export default (${JSON.stringify({ ...baseline, pipelines: { release: [command] } })} satisfies import('limina').LiminaConfig);`,
  );
  assert.equal(
    validateMutations(task, start, await captureSnapshot(root, 'S1')).status,
    'accepted',
  );
  // Authorizing a pipeline never authorizes unrelated governance or extra pipelines.
  for (const value of [
    { ...baseline, source: { knip: true }, pipelines: { release: [command] } },
    { ...baseline, pipelines: { release: [command], extra: [command] } },
  ]) {
    await writeFile(
      config,
      `export default (${JSON.stringify(value)} satisfies import('limina').LiminaConfig);`,
    );
    const rejected = validateMutations(
      task,
      start,
      await captureSnapshot(root, 'S1'),
    );
    assert.equal(rejected.status, 'unsafe');
    if (rejected.status === 'unsafe')
      assert.ok(
        rejected.violations.some((entry) => entry.code === 'json_field'),
      );
  }
});
