import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taskCatalog } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { type BankRevision, createTaskBank } from '../core/task-bank.ts';
import { developmentTasksForRevision } from '../tasks/banks.ts';
import { calibrateTask, type TaskDefinition } from './calibration.ts';
import { reviewedRuntime, type RuntimeAdmission } from './formal.ts';
import { admitTaskSuite } from './suite.ts';

export async function prepareBankV2(
  source: string,
  output: string,
  promptsFile: string,
) {
  return prepareVersionedBank(source, output, promptsFile, 'v2');
}
export async function prepareBankV21(
  source: string,
  output: string,
  promptsFile: string,
) {
  return prepareVersionedBank(source, output, promptsFile, 'v2.1');
}
export async function prepareBankV22(
  source: string,
  output: string,
  promptsFile: string,
) {
  return prepareVersionedBank(source, output, promptsFile, 'v2.2');
}
async function prepareVersionedBank(
  source: string,
  output: string,
  promptsFile: string,
  revision: Exclude<BankRevision, 'v1'>,
) {
  if (
    (await realpath(source)) !== source ||
    !path.isAbsolute(output) ||
    (await realpath(path.dirname(output))) !== path.dirname(output) ||
    output.startsWith(source + path.sep) ||
    source.startsWith(output + path.sep)
  )
    throw new Error('Bank stores must be distinct canonical roots');
  const prompts = JSON.parse(await readFile(promptsFile, 'utf8')) as Record<
    string,
    string
  >;
  const sealed = taskCatalog.filter((t) => t.split === 'sealed');
  if (
    Object.keys(prompts).length !== 9 ||
    sealed.some(
      (t) => typeof prompts[t.id] !== 'string' || !prompts[t.id]!.trim(),
    )
  )
    throw new Error('Nine versioned sealed prompts required');
  await mkdir(output, { mode: 0o700 });
  const previous = { v2: 'v1-input', 'v2.1': 'v2-input', 'v2.2': 'v2_1-input' }[
    revision
  ];
  for (const task of sealed) {
    const frozen = path.join(output, task.id, previous);
    await mkdir(frozen, { mode: 0o700, recursive: true });
    const sourceDirectory = path.join(source, task.id);
    const entry = path.join(sourceDirectory, 'task.ts');
    const { definition } = (await import(pathToFileURL(entry).href)) as {
      definition: TaskDefinition;
    };
    const inputs = new Set([
      entry,
      ...definition.sourceFiles,
      ...definition.graderFiles,
    ]);
    async function copyFrozenSource(file: string): Promise<void> {
      const info = await lstat(file);
      const destination = path.resolve(
        frozen,
        path.relative(sourceDirectory, file),
      );
      if (
        !info.isFile() ||
        (await realpath(file)) !== file ||
        !file.startsWith(source + path.sep) ||
        !destination.startsWith(path.join(output, task.id) + path.sep)
      )
        throw new Error('Bank source closure escapes its frozen task');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(file, destination);
    }
    for (const file of inputs) await copyFrozenSource(file);
    const adapter = fileURLToPath(
      new URL(
        `../tasks/${revision.replace('.', '_')}/index.ts`,
        import.meta.url,
      ),
    );
    const constructorName = {
      v2: 'createV2Definition',
      'v2.1': 'createV21Definition',
      'v2.2': 'createV22Definition',
    }[revision];
    let closure =
      'definition.sourceFiles.push(fileURLToPath(import.meta.url));';
    if (revision !== 'v2') {
      const metadata = path.join(output, task.id, 'package.json');
      try {
        await writeFile(metadata, '{"private":true,"type":"module"}\n', {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          JSON.parse(await readFile(metadata, 'utf8')).type !== 'module'
        )
          throw error;
      }
      closure =
        "definition.sourceFiles=[...new Set([...definition.sourceFiles,fileURLToPath(import.meta.url),fileURLToPath(new URL('./package.json',import.meta.url))])];";
    }
    const body = `import {fileURLToPath} from 'node:url';\nimport {definition as original} from './${previous}/task.ts';\nimport {${constructorName}} from ${JSON.stringify(adapter)};\nexport const definition=${constructorName}(original,${JSON.stringify(prompts[task.id])});\n${closure}\n`;
    await writeFile(path.join(output, task.id, 'task.ts'), body, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  return { revision, tasks: 26, sealedTasks: 9, modelCalls: 0 };
}
interface CalibrationPlan {
  version: 1;
  repository: string;
  sealedStore: string;
  output: string;
  runtimes: RuntimeAdmission[];
}
export async function calibrateBank(
  file: string,
  revision: BankRevision = 'v2',
) {
  const developmentTasks = developmentTasksForRevision(revision);
  const c = JSON.parse(await readFile(file, 'utf8')) as CalibrationPlan;
  if (
    c.version !== 1 ||
    !path.isAbsolute(c.output) ||
    (await realpath(path.dirname(c.output))) !== path.dirname(c.output) ||
    !c.output.startsWith(c.sealedStore + path.sep) ||
    c.output.startsWith(c.repository + path.sep)
  )
    throw new Error('Calibration output must be new private storage');
  const configs = new Map<
    string,
    Awaited<ReturnType<typeof reviewedRuntime>>
  >();
  for (const name of ['base', 'vue', 'framework', 'migration']) {
    const matches = c.runtimes.filter((r) => r.name === name);
    if (matches.length !== 1 || c.runtimes.length !== 4)
      throw new Error('Four reviewed runtimes required');
    configs.set(name, await reviewedRuntime(matches[0]!));
  }
  await mkdir(c.output, { mode: 0o700 });
  const results = [];
  const calibrations = [];
  for (const meta of taskCatalog) {
    const definition =
      meta.split === 'dev'
        ? developmentTasks.find((t) => t.id === meta.id)!
        : (
            (await import(
              pathToFileURL(path.join(c.sealedStore, meta.id, 'task.ts')).href
            )) as { definition: TaskDefinition }
          ).definition;
    const runtime =
      meta.id === 'K01'
        ? 'vue'
        : meta.id === 'K02'
          ? 'framework'
          : meta.id === 'W03'
            ? 'migration'
            : 'base';
    const config = configs.get(runtime)!;
    const directory = path.join(c.output, meta.id);
    const receipt = await calibrateTask({
      definition,
      output: directory,
      docker: config.docker,
      closureDigest: config.runtimeBundle.digest,
    });
    results.push({
      id: meta.id,
      directory,
      runtime,
      docker: config.docker,
      closureDigest: config.runtimeBundle.digest,
      identity: receipt.task,
      calibrationDigest: contentIdentity(receipt),
      cases: receipt.results.length,
    });
    calibrations.push({
      definition,
      directory,
      docker: config.docker,
      closureDigest: config.runtimeBundle.digest,
    });
  }
  const suite = await admitTaskSuite({
    calibrations,
    sealedStore: c.sealedStore,
    repository: c.repository,
  });
  const bank = createTaskBank(
    revision,
    suite.tasks.map((t) => ({ task: t.task, identity: t.identity })),
  );
  await writeFile(
    path.join(c.output, 'suite-calibrations.json'),
    `${JSON.stringify({
      scope: 'controller-calibration',
      formalDispatchAuthorized: false,
      modelCalls: 0,
      results,
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    path.join(c.output, 'bank.json'),
    `${JSON.stringify(bank)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const packet = path.join(c.output, 'task-review');
  await mkdir(packet, { mode: 0o700 });
  for (const task of suite.tasks) {
    await writeFile(
      path.join(packet, `${task.task.id}.json`),
      `${JSON.stringify({
        task: {
          id: task.task.id,
          split: task.task.split,
          domain: task.task.domain,
          prompt: task.task.prompt,
          mutationPolicy: task.task.mutationPolicy,
          capturePolicy: task.task.capturePolicy,
          dependencyPolicy: task.task.dependencyPolicy,
          installPlan: task.task.installPlan,
        },
        fixture: task.fixture,
        bankId: bank.id,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  }
  return {
    bankId: bank.id,
    suiteAdmissionId: suite.identity,
    tasks: 26,
    modelCalls: 0,
    graderCalibration: 'passed',
    taskCalibration: 'pending-independent-review',
  };
}
