import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { taskCatalog } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { materializeSnapshot } from '../core/reconstruction.ts';
import type { RunStore } from '../core/run-store.ts';
import { captureSnapshot, sha256, type Snapshot } from '../core/snapshot.ts';
import type { DockerIdentity } from '../runner/docker-verifier.ts';
import { type AdmittedTask, verifyAdmittedTask } from './calibration.ts';
import { verifyPreparedInputs } from './preflight.ts';

interface DevelopmentInput {
  task: AdmittedTask;
  docker: DockerIdentity;
  closureDigest: string;
}
export interface RevisionExport {
  readonly directory: string;
  readonly workspace: string;
  readonly snapshot: Snapshot;
  readonly identity: string;
  readonly preparedIdentity: string;
  readonly skillDigest: string;
  readonly developmentIdentities: readonly string[];
}
const exports = new WeakSet<object>();
const isWithin = (root: string, file: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);

async function assertNoGitAncestor(directory: string): Promise<void> {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await lstat(path.join(current, '.git'));
      throw new Error(
        'Revision workspace cannot inherit a host Git repository',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) return;
  }
}

/**
Project only known fields. Never spread a result, copy traces, or follow its
evidence paths: those are controller data, not revision input.
*/
export function projectDevelopmentDiagnostics(
  store: RunStore,
  tasks: readonly Pick<AdmittedTask, 'task' | 'identity'>[],
) {
  if (store.manifest.inputs.kind !== 'development')
    throw new Error('Revision diagnostics require a development-only batch');
  const expected = taskCatalog.filter((task) => task.split === 'dev');
  if (
    store.manifest.inputs.tasks.length !== expected.length ||
    expected.some(
      (task) =>
        store.manifest.inputs.tasks.filter((input) => input.id === task.id)
          .length !== 1,
    )
  )
    throw new Error('Development diagnostic membership changed');
  for (const input of store.manifest.inputs.tasks) {
    const admitted = tasks.find((task) => task.task.id === input.id);
    if (
      !admitted ||
      admitted.task.split !== 'dev' ||
      contentIdentity(admitted.identity) !== contentIdentity(input)
    )
      throw new Error(
        'Diagnostics do not match the admitted development tasks',
      );
  }
  const summary = store.summary();
  if (summary.inFlight)
    throw new Error('Do not revise from an in-flight development batch');
  return summary.slots.map((slot) => {
    const task = tasks.find((value) => value.task.id === slot.slot.taskId)!;
    const grade = slot.selected?.facts.grade;
    return {
      taskId: task.task.id,
      condition: slot.slot.condition,
      repetition: slot.slot.repetition,
      status: slot.status,
      evidence: slot.evidenceStatus,
      execution: slot.selected?.facts.execution.status ?? 'not_run',
      capture: slot.selected?.facts.captureStatus ?? 'unknown',
      assertions: task.task.gradingContract.requiredAssertions.map((id) => ({
        id,
        passed:
          slot.evidenceStatus === 'complete' &&
          grade?.status === 'complete' &&
          grade.graderDigest === task.task.gradingContract.graderDigest
            ? (grade.assertions.find((assertion) => assertion.id === id)
                ?.passed ?? null)
            : null,
      })),
    };
  });
}

/**
Export inert development material into a fresh workspace. Filesystem isolation
of the later Codex process is a separate required runtime gate.
*/
export async function exportRevisionInputs(input: {
  preparedDirectory: string;
  development: readonly DevelopmentInput[];
  output: string;
  protectedRoots: readonly string[];
  developmentRun?: RunStore;
}): Promise<RevisionExport> {
  const expected = taskCatalog.filter((task) => task.split === 'dev');
  if (
    input.development.length !== expected.length ||
    expected.some(
      (task) =>
        input.development.filter(
          (value) =>
            value.task.task.id === task.id && value.task.task.split === 'dev',
        ).length !== 1,
    )
  )
    throw new Error(
      'Revision export requires exactly the frozen 17 development tasks',
    );
  if (
    !path.isAbsolute(input.output) ||
    (await realpath(path.dirname(input.output))) !== path.dirname(input.output)
  )
    throw new Error('Revision output parent must be canonical');
  const roots = [
    input.preparedDirectory,
    ...input.protectedRoots,
    ...input.development.map((value) => value.task.calibrationDirectory),
  ];
  if (input.developmentRun) roots.push(input.developmentRun.directory);
  for (const root of roots) {
    if (
      !path.isAbsolute(root) ||
      (await realpath(root)) !== root ||
      isWithin(root, input.output) ||
      isWithin(input.output, root)
    )
      throw new Error(
        'Revision workspace must be disjoint from protected storage',
      );
  }
  await assertNoGitAncestor(path.dirname(input.output));
  const prepared = await verifyPreparedInputs(input.preparedDirectory);
  if (
    input.developmentRun &&
    (input.developmentRun.manifest.inputs.preparedInputsDigest !==
      prepared.identity ||
      input.developmentRun.manifest.inputs.conditions.find(
        (condition) => condition.id === 'skill',
      )?.skillDigest !== prepared.skillDigest)
  )
    throw new Error(
      'Development evidence and revision inputs use different frozen products or Skills',
    );
  for (const value of input.development)
    await verifyAdmittedTask(value.task, value.docker, value.closureDigest);
  const diagnostics = input.developmentRun
    ? projectDevelopmentDiagnostics(
        input.developmentRun,
        input.development.map((value) => value.task),
      )
    : [];
  await mkdir(input.output, { mode: 0o700 });
  const workspace = path.join(input.output, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  const write = async (relative: string, bytes: string | Buffer) => {
    const destination = path.join(workspace, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
  };
  const source = path.join(input.preparedDirectory, 'source');
  const skill = await captureSnapshot(path.join(source, 'skills/limina'), 'F0');
  if (skill.status !== 'complete' || skill.digest !== prepared.skillDigest)
    throw new Error('Skill changed while exporting');
  await mkdir(path.join(workspace, 'skills'));
  await materializeSnapshot(skill, path.join(workspace, 'skills/limina'));
  for (const file of prepared.repository.files) {
    if (!/^docs\/(?:en|zh)\/.+\.md$/u.test(file.path) || file.sha256 === null)
      continue;
    const bytes = await readFile(path.join(source, file.path));
    if (sha256(bytes) !== file.sha256)
      throw new Error('Public contract changed while exporting');
    await write(`public/${file.path}`, bytes);
  }
  for (const value of input.development) {
    const task = value.task.task;
    const directory = path.join(workspace, 'development', task.id);
    await mkdir(directory, { recursive: true });
    await materializeSnapshot(
      value.task.fixture,
      path.join(directory, 'fixture'),
    );
    await write(
      `development/${task.id}/task.json`,
      `${JSON.stringify({ id: task.id, domain: task.domain, prompt: task.prompt, mutationPolicy: task.mutationPolicy, dependencyPolicy: task.dependencyPolicy, requiredAssertions: task.gradingContract.requiredAssertions }, null, 2)}\n`,
    );
  }
  await write(
    'development/diagnostics.json',
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );
  const snapshot = await captureSnapshot(workspace, 'S0');
  if (snapshot.status !== 'complete' || !snapshot.digest)
    throw new Error('Revision export capture incomplete');
  const body = {
    version: 1,
    preparedIdentity: prepared.identity,
    skillDigest: prepared.skillDigest,
    developmentRunIdentity: input.developmentRun?.manifest.identity ?? null,
    developmentIdentities: input.development
      .map((value) => contentIdentity(value.task.identity))
      .toSorted((a, b) => a.localeCompare(b)),
    workspaceDigest: snapshot.digest,
  };
  const identity = contentIdentity(body);
  await writeFile(
    path.join(input.output, 'export.json'),
    `${JSON.stringify({ ...body, identity }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const result = Object.freeze({
    directory: input.output,
    workspace,
    snapshot,
    identity,
    preparedIdentity: prepared.identity,
    skillDigest: prepared.skillDigest,
    developmentIdentities: Object.freeze(body.developmentIdentities),
  });
  exports.add(result);
  return result;
}

export async function verifyRevisionExport(
  value: RevisionExport,
): Promise<void> {
  if (!exports.has(value))
    throw new Error('Revision input was not exported by the controller');
  const stored = JSON.parse(
    await readFile(path.join(value.directory, 'export.json'), 'utf8'),
  );
  const { identity, ...body } = stored;
  const current = await captureSnapshot(value.workspace, 'S0');
  if (
    identity !== value.identity ||
    contentIdentity(body) !== identity ||
    current.status !== 'complete' ||
    current.digest !== value.snapshot.digest ||
    body.workspaceDigest !== current.digest
  )
    throw new Error('Revision input identity changed');
}
