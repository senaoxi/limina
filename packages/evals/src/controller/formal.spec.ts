import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { contentIdentity } from '../core/identity.ts';
import { sha256 } from '../core/snapshot.ts';
import { executeFormal, loadFormalInputs, reviewedRuntime } from './formal.ts';

test('a small trial or larger budget cannot silently become the formal plan', async () => {
  for (const [kind, count, total] of [
    ['smoke', 2, 100],
    ['development', 102, 101],
    ['sealed', 53, 100],
    ['confirmation', 234, 99],
    ['smoke', 3, 150],
  ] as const)
    await assert.rejects(
      executeFormal(kind, 'absent-controller', total, count),
      /full preregistered/,
    );
});

test('versioned banks cannot enter a legacy dispatch without a frozen campaign profile', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-v2-mode-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const file = path.join(root, 'plan.json');
  for (const bankRevision of ['v2', 'v2.1', 'v2.2']) {
    await writeFile(file, JSON.stringify({ bankRevision }), { mode: 0o600 });
    await assert.rejects(
      executeFormal('development', file, 100, 102),
      /V2(?:\.[12])? dispatch requires a Campaign/,
    );
  }
});

test('unknown bank revisions fail before legacy dispatch or runtime preflight', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-bank-revision-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const file = path.join(root, 'plan.json');
  for (const bankRevision of ['v2.10', 'v3', '', null]) {
    await writeFile(file, JSON.stringify({ bankRevision }), { mode: 0o600 });
    await assert.rejects(loadFormalInputs(file), /Unsupported task bank/);
    await assert.rejects(
      executeFormal('development', file, 100, 102),
      /Unsupported task bank/,
    );
  }
});

test('versioned banks require independent task review before runtime admission', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-task-review-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const sealedStore = path.join(root, 'controller');
  await mkdir(sealedStore, { mode: 0o700 });
  const file = path.join(sealedStore, 'plan.json');
  for (const bankRevision of ['v2', 'v2.1', 'v2.2']) {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        seed: 'independent offline task review',
        bankRevision,
        sealedStore,
        repository: path.join(root, 'repository'),
        volumeParent: path.join(root, 'volumes'),
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadFormalInputs(file),
      /Independent V2(?:\.[12])? task calibration is required/,
    );
  }
});

test('a campaign cannot escape controller storage before runtime admission', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-campaign-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const sealedStore = path.join(root, 'controller');
  await mkdir(sealedStore, { mode: 0o700 });
  const file = path.join(sealedStore, 'plan.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      seed: 'synthetic campaign test',
      campaign: '../escape',
      sealedStore,
      repository: path.join(root, 'repository'),
      volumeParent: path.join(root, 'volumes'),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    executeFormal('smoke', file, 100, 3),
    /single controlled path segment/,
  );
});

test('formal dispatch treats file, directory and broken-link stop markers as closed', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-dispatch-stop-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const controller = path.join(root, 'controller');
  const volumes = path.join(root, 'volumes');
  const formal = path.join(controller, 'formal');
  await mkdir(formal, { recursive: true, mode: 0o700 });
  await mkdir(volumes, { mode: 0o700 });
  const file = path.join(controller, 'plan.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      seed: 'synthetic offline stop test',
      sealedStore: controller,
      volumeParent: volumes,
      repository: path.join(root, 'repository'),
    }),
    { mode: 0o600 },
  );
  const marker = path.join(formal, 'STOP');
  for (const kind of ['file', 'directory', 'broken-link']) {
    if (kind === 'file') await writeFile(marker, 'closed');
    else if (kind === 'directory') await mkdir(marker);
    else await symlink('missing-target', marker);
    await assert.rejects(
      executeFormal('smoke', file, 100, 3),
      /Controller dispatch stopped/,
    );
    await rm(marker, { recursive: true, force: true });
  }
});

test('an approved technical review cannot replace a license decision or admit changed evidence', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-admission-'));
  try {
    const root = await realpath(temporary);
    const file = async (name: string, value: unknown) => {
      const bytes = JSON.stringify(value);
      const target = path.join(root, name);
      await writeFile(target, bytes, { mode: 0o600 });
      return { file: target, sha256: sha256(bytes) };
    };
    const closure = contentIdentity('closure');
    const image = `sha256:${contentIdentity('image')}`;
    const config = await file('profile', {
      runtimeBundle: { digest: closure },
      docker: { image },
    });
    const artifact = await file('technical', { syntheticOfflineTest: true });
    const fields = {
      status: 'admitted',
      closure,
      image,
      artifactsDigest: contentIdentity([artifact]),
    };
    const input = {
      name: 'framework',
      closure,
      image,
      config,
      artifacts: [artifact],
      review: await file('review', fields),
    };
    await assert.rejects(reviewedRuntime(input), /MPL review missing/);
    const decision = await file('decision', {
      decision: 'approved',
      package: 'lightningcss@1.33.0',
      scope: 'unchanged-private-local-no-distribution',
      maintainerSource: 'synthetic offline test',
      closure: contentIdentity('other closure'),
    });
    input.review = await file('review', {
      ...fields,
      licenseDecision: decision,
    });
    await assert.rejects(
      reviewedRuntime(input),
      /exact private framework runtime/,
    );
    await writeFile(artifact.file, 'changed');
    await assert.rejects(reviewedRuntime(input), /evidence changed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
