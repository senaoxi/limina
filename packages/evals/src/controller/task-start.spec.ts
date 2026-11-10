import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureTaskSnapshot } from '../core/capture-policy.ts';
import {
  dependencyInputsIdentity,
  validateMutations,
} from '../core/mutation.ts';
import {
  materializeSnapshot,
  reconstructForVerifier,
} from '../core/reconstruction.ts';
import {
  captureSnapshot,
  compareAgentSnapshots,
  type Snapshot,
} from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import {
  installAgentRuntime,
  prepareTaskState,
  verifyAgentRuntime,
} from '../runner/task-workspace.ts';

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-task-start-'));
  const root = await realpath(temporary);
  const bundle = path.join(root, 'runtime');
  await mkdir(path.join(bundle, 'node_modules/tool'), { recursive: true });
  await writeFile(
    path.join(bundle, 'node_modules/tool/index.js'),
    'export const value=7;',
  );
  const runtime = await captureSnapshot(bundle, 'F0');
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'packages/app'), { recursive: true });
  await mkdir(path.join(source, 'packages/lib'));
  await writeFile(path.join(source, 'package.json'), '{"private":true}');
  await writeFile(path.join(source, 'answer.txt'), 'before');
  const original = await captureSnapshot(source, 'F0');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  const task: TaskSpec = {
    version: 2,
    id: 'start-contract',
    split: 'dev',
    domain: 'initialization',
    prompt: 'Update answer.',
    fixtureDigest: original.digest!,
    capturePolicy: {
      excludedRoots: ['node_modules', 'packages/app/node_modules'],
      requiredRoots: [],
    },
    mutationPolicy: {
      protectedRoots: ['package.json'],
      rules: [{ path: 'answer.txt', operations: ['modify'] }],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'fixed',
          inputsDigest: dependencyInputsIdentity(original, inputs),
          closureDigest: runtime.digest!,
        },
      ],
    },
    installPlan: {
      toolchainDigest: 'fixed',
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
      projectLinks: [
        {
          path: 'packages/app/node_modules/@example/lib',
          target: '../../../lib',
        },
      ],
    },
    gradingContract: { graderDigest: 'fixed', requiredAssertions: [] },
  };
  const skillDirectory = path.join(root, 'skill');
  await mkdir(path.join(skillDirectory, 'references'), { recursive: true });
  await writeFile(
    path.join(skillDirectory, 'SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nUse the reference.',
  );
  await writeFile(
    path.join(skillDirectory, 'references/detail.md'),
    'Full treatment input.',
  );
  return {
    root,
    bundle,
    source,
    original,
    task,
    runtime,
    skill: await captureSnapshot(skillDirectory, 'F0'),
  };
}

test('S0 contains complete treatment while runtime links stay outside project diff and verifier replay', async () => {
  const f = await fixture();
  try {
    const receipt = await installAgentRuntime(
      f.task,
      { directory: f.bundle, digest: f.runtime.digest! },
      f.source,
    );
    await prepareTaskState(f.source, f.skill);
    const start = await captureTaskSnapshot(f.source, 'S0', f.task);
    assert.equal(start.status, 'complete');
    assert.ok(
      start.entries.some(
        (entry) => entry.path === '.agents/skills/limina/references/detail.md',
      ),
    );
    assert.ok(
      f.original.entries.every((entry) => !entry.path.startsWith('.agents')),
    );
    await writeFile(path.join(f.source, 'answer.txt'), 'after');
    const final = await captureTaskSnapshot(f.source, 'S1', f.task);
    assert.deepEqual(
      compareAgentSnapshots(start, final).map((c) => c.path),
      ['answer.txt'],
    );
    assert.equal(validateMutations(f.task, start, final).status, 'accepted');
    const rebuilt = await reconstructForVerifier({
      task: f.task,
      fixture: f.original,
      start,
      final,
      destination: path.join(f.root, 'reconstructed'),
      prepareStart: (d) => prepareTaskState(d, f.skill),
    });
    assert.ok(rebuilt.project);
    assert.equal(
      await readFile(
        path.join(rebuilt.project.directory, 'answer.txt'),
        'utf8',
      ),
      'after',
    );
    await assert.rejects(
      readFile(
        path.join(rebuilt.project.directory, 'node_modules/tool/index.js'),
      ),
      /ENOENT/,
    );
    await verifyAgentRuntime(f.source, receipt);
    await assert.rejects(
      verifyAgentRuntime(f.source, structuredClone(receipt)),
      /receipt changed/,
    );
    await writeFile(
      path.join(f.source, '.agents/skills/limina/references/detail.md'),
      'tampered',
    );
    assert.equal(
      validateMutations(
        f.task,
        start,
        await captureTaskSnapshot(f.source, 'S1', f.task),
      ).status,
      'unsafe',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('runtime preparation refuses changed closures and escaping or aliased dependency links', async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.bundle, 'node_modules/tool/index.js'),
      'changed',
    );
    await assert.rejects(
      installAgentRuntime(
        f.task,
        { directory: f.bundle, digest: f.runtime.digest! },
        f.source,
      ),
      /bundle changed/,
    );
    await assert.rejects(
      readFile(path.join(f.source, 'node_modules/tool/index.js')),
      /ENOENT/,
    );
    await writeFile(
      path.join(f.bundle, 'node_modules/tool/index.js'),
      'export const value=7;',
    );
    for (const link of [
      { path: 'packages/app/node_modules/bad', target: '../../../../outside' },
      { path: 'answer.txt', target: 'packages/lib' },
    ]) {
      const task = structuredClone(f.task);
      task.installPlan.projectLinks = [link];
      await assert.rejects(
        installAgentRuntime(
          task,
          { directory: f.bundle, digest: f.runtime.digest! },
          f.source,
        ),
      );
    }
    await symlink('/etc', path.join(f.bundle, 'node_modules/escape'));
    const changed = await captureSnapshot(f.bundle, 'F0');
    const task = structuredClone(f.task);
    task.dependencyPolicy.variants[0]!.closureDigest = changed.digest!;
    await assert.rejects(
      installAgentRuntime(
        task,
        { directory: f.bundle, digest: changed.digest! },
        f.source,
      ),
      /escapes/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('post-run checks detect protected dependency content and package-link replacement independently', async () => {
  const f = await fixture();
  try {
    const receipt = await installAgentRuntime(
      f.task,
      { directory: f.bundle, digest: f.runtime.digest! },
      f.source,
    );
    await writeFile(
      path.join(f.source, 'node_modules/tool/index.js'),
      'altered',
    );
    await assert.rejects(
      verifyAgentRuntime(f.source, receipt),
      /dependencies changed/,
    );
    await writeFile(
      path.join(f.source, 'node_modules/tool/index.js'),
      'export const value=7;',
    );
    const link = path.join(f.source, 'packages/app/node_modules/@example/lib');
    await rm(link);
    await symlink('../../../app', link);
    await assert.rejects(verifyAgentRuntime(f.source, receipt), /link changed/);
    const base = path.join(f.root, 'base');
    await materializeSnapshot(f.original, base);
    await prepareTaskState(base);
    const s0: Snapshot = await captureTaskSnapshot(base, 'S0', f.task);
    assert.deepEqual(
      s0.entries
        .filter((entry) => entry.path.startsWith('.agents'))
        .map((entry) => entry.path),
      ['.agents'],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
