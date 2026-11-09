import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { campaignFixture } from '../core/campaign.test-helper.ts';
import { taskCatalog } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { captureSnapshot } from '../core/snapshot.ts';
import type { BankRevision } from '../core/task-bank.ts';
import { developmentTasksForRevision } from '../tasks/banks.ts';
import { type TaskDefinition, writeFixture } from './calibration.ts';
import { calibrateBank, prepareBankV2, prepareBankV21 } from './task-bank.ts';

test('sealed preparation preserves declared module, fixture and generated-input closure', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-bank-source-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const moduleIdentity = '{"private":true,"type":"module"}\n';
  await writeFile(path.join(source, 'package.json'), moduleIdentity);
  const prompts: Record<string, string> = {};
  const sealed = taskCatalog.filter((task) => task.split === 'sealed');
  for (const task of sealed) {
    const directory = path.join(source, task.id);
    await mkdir(directory);
    const code = `import {fileURLToPath} from 'node:url';\nexport const definition={sourceFiles:['./task.ts','./fixture.ts','./generated.json','../package.json'].map(p=>fileURLToPath(new URL(p,import.meta.url))),graderFiles:[fileURLToPath(new URL('./grader.ts',import.meta.url))]};\n`;
    await writeFile(path.join(directory, 'task.ts'), code);
    await writeFile(
      path.join(directory, 'fixture.ts'),
      'export const files = {};\n',
    );
    await writeFile(
      path.join(directory, 'generated.json'),
      '{"retained":"exact bytes"}\n',
    );
    await writeFile(
      path.join(directory, 'grader.ts'),
      'export function grade() {}\n',
    );
    prompts[task.id] =
      'Keep the permitted operations and deliverable explicit.';
  }
  const promptsFile = path.join(root, 'prompts.json');
  await writeFile(promptsFile, JSON.stringify(prompts));
  const destination = path.join(root, 'v2');
  await prepareBankV2(source, destination, promptsFile);
  for (const id of Object.keys(prompts)) {
    assert.equal(
      await readFile(path.join(destination, id, 'package.json'), 'utf8'),
      moduleIdentity,
    );
    assert.equal(
      await readFile(
        path.join(destination, id, 'v1-input', 'generated.json'),
        'utf8',
      ),
      '{"retained":"exact bytes"}\n',
    );
    assert.equal(
      await readFile(path.join(destination, id, 'v1-input', 'task.ts'), 'utf8'),
      await readFile(path.join(source, id, 'task.ts'), 'utf8'),
    );
  }
});

test('the exact revision registry creates schema-2 development tasks without fallback', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-bank-registry-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const fixed = contentIdentity('offline registry task construction');
  for (const revision of ['v1', 'v2', 'v2.1'] as const) {
    const bankDirectory = path.join(root, revision);
    await mkdir(bankDirectory);
    const definitions = developmentTasksForRevision(revision);
    assert.equal(definitions.length, 17);
    for (const definition of definitions) {
      const directory = path.join(bankDirectory, definition.id);
      await writeFixture(definition.files, directory);
      const fixture = await captureSnapshot(directory, 'F0');
      const task = definition.createTask(fixture, {
        closure: fixed,
        toolchain: fixed,
        grader: fixed,
      });
      assert.equal(task.id, definition.id);
      assert.equal(task.version, 2);
      assert.equal(task.split, 'dev');
      assert.equal(task.bankRevision, revision === 'v1' ? undefined : revision);
    }
  }
  for (const revision of ['v2.10', 'V2.1', '', '__proto__']) {
    assert.throws(
      () => developmentTasksForRevision(revision as BankRevision),
      /Unsupported task bank revision/,
    );
    await assert.rejects(
      calibrateBank('absent-calibration-plan', revision as BankRevision),
      /Unsupported task bank revision/,
    );
  }
});

test('v2.1 sealed preparation retains nested V2 closures and refuses existing output', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-bank-nested-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'original');
  await mkdir(source);
  const metadata = '{"private":true,"type":"module"}\n';
  await writeFile(path.join(source, 'package.json'), metadata);
  const originals = campaignFixture('v1').tasks.filter(
    (task) => task.split === 'sealed',
  );
  const prompts: Record<string, string> = {};
  for (const task of originals) {
    const directory = path.join(source, task.id);
    await mkdir(path.join(directory, 'inputs'), { recursive: true });
    await writeFile(path.join(directory, 'inputs', 'package.json'), metadata);
    await writeFile(
      path.join(directory, 'inputs', 'generated.json'),
      `${JSON.stringify({ taskId: task.id, preserved: 'nested input bytes' })}\n`,
    );
    await writeFile(
      path.join(directory, 'inputs', 'fixture.ts'),
      "import data from './generated.json' with {type:'json'};\nexport const files={'fixture.json':JSON.stringify(data)+'\\n'};\n",
    );
    await writeFile(
      path.join(directory, 'grader.ts'),
      "export function grade(){throw new Error('Loader fixture must not grade')};\n",
    );
    const code = `import {fileURLToPath} from 'node:url';\nimport {files as fixtureFiles} from './inputs/fixture.ts';\nimport {grade as runGrade} from './grader.ts';\nexport const definition={id:${JSON.stringify(task.id)},files:fixtureFiles,sourceFiles:['./task.ts','./inputs/fixture.ts','./inputs/generated.json','./inputs/package.json','../package.json'].map(p=>fileURLToPath(new URL(p,import.meta.url))),graderFiles:[fileURLToPath(new URL('./grader.ts',import.meta.url))],createTask(fixture){return {...${JSON.stringify(task)},fixtureDigest:fixture.digest}},grade:runGrade,cases:[]};\n`;
    await writeFile(path.join(directory, 'task.ts'), code);
    prompts[task.id] = 'Preserve the declared task boundaries.';
  }
  const promptsFile = path.join(root, 'prompts.json');
  await writeFile(promptsFile, JSON.stringify(prompts));
  const prior = path.join(root, 'v2');
  const destination = path.join(root, 'v2.1');
  await prepareBankV2(source, prior, promptsFile);
  const before = await captureSnapshot(prior, 'F0');
  const child = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../cli.ts', import.meta.url)),
    'prepare-bank',
    '--bank',
    'v2.1',
    '--source-store',
    prior,
    '--output',
    destination,
    '--prompts',
    promptsFile,
  ]);
  const result = JSON.parse(child.stdout);
  assert.equal(result.revision, 'v2.1');
  const retainedPrior = await captureSnapshot(prior, 'F0');
  assert.equal(retainedPrior.digest, before.digest);
  const fixed = contentIdentity('offline sealed wrapper construction');
  for (const task of originals) {
    const previousDirectory = path.join(prior, task.id);
    const directory = path.join(destination, task.id);
    for (const relative of [
      'task.ts',
      'package.json',
      path.join('v1-input', 'task.ts'),
      path.join('v1-input', 'grader.ts'),
      path.join('v1-input', 'inputs', 'fixture.ts'),
      path.join('v1-input', 'inputs', 'generated.json'),
      path.join('v1-input', 'inputs', 'package.json'),
    ])
      assert.deepEqual(
        await readFile(path.join(directory, 'v2-input', relative)),
        await readFile(path.join(previousDirectory, relative)),
      );
    const { definition } = (await import(
      pathToFileURL(path.join(directory, 'task.ts')).href
    )) as { definition: TaskDefinition };
    assert.equal(JSON.parse(definition.files['fixture.json']!).taskId, task.id);
    const created = definition.createTask(before, {
      closure: fixed,
      toolchain: fixed,
      grader: fixed,
    });
    assert.equal(created.version, 2);
    assert.equal(created.bankRevision, 'v2.1');
    assert.equal(created.prompt, prompts[task.id]);
    assert.ok(
      definition.sourceFiles.includes(path.join(directory, 'package.json')),
    );
    const priorModule = (await import(
      pathToFileURL(path.join(previousDirectory, 'task.ts')).href
    )) as { definition: TaskDefinition };
    assert.equal(
      priorModule.definition.createTask(before, {
        closure: fixed,
        toolchain: fixed,
        grader: fixed,
      }).bankRevision,
      'v2',
    );
  }
  const prepared = await captureSnapshot(destination, 'F0');
  await assert.rejects(
    prepareBankV21(prior, destination, promptsFile),
    /EEXIST/,
  );
  const retainedPrepared = await captureSnapshot(destination, 'F0');
  assert.equal(retainedPrepared.digest, prepared.digest);
});
