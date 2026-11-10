import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFixtureCaptureScope,
  captureTaskSnapshot,
} from '../core/capture-policy.ts';
import { GradingDeadline } from '../core/deadline.ts';
import { freezeTaskIdentity } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { validateMutations } from '../core/mutation.ts';
import { type AssertionReport, deriveOutcome } from '../core/outcome.ts';
import {
  materializeSnapshot,
  type ReconstructedProject,
  reconstructForVerifier,
} from '../core/reconstruction.ts';
import {
  assertRelativePath,
  captureSnapshot,
  sha256,
  type Snapshot,
  verifySnapshot,
} from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import {
  type CommandEvidence,
  type DockerIdentity,
  DockerVerifier,
} from '../runner/docker-verifier.ts';
import { prepareTaskState } from '../runner/task-workspace.ts';

export interface TaskIdentities {
  closure: string;
  toolchain: string;
  grader: string;
}
export interface CalibrationCase {
  id: string;
  expected: 'passed' | 'failed' | 'unsafe';
  expectedFailedAssertions?: string[];
  expectedViolationCodes?: string[];
  edits: { path: string; content: string | null; mode?: number }[];
}
export interface TaskDefinition {
  id: string;
  files: Record<string, string>;
  sourceFiles: string[];
  graderFiles: string[];
  createTask: (fixture: Snapshot, identities: TaskIdentities) => TaskSpec;
  grade: (
    task: TaskSpec,
    fixture: Snapshot,
    final: Snapshot,
    verifier: DockerVerifier,
  ) => Promise<{ report: AssertionReport; commands: CommandEvidence[] }>;
  cases: CalibrationCase[];
}

export async function codeIdentity(files: string[]): Promise<string> {
  if (files.length === 0 || new Set(files).size !== files.length)
    throw new Error('Code identity requires distinct source files');
  const entries = [];
  for (const file of files) {
    if (!path.isAbsolute(file) || (await realpath(file)) !== file)
      throw new Error('Controller code must use canonical paths');
    entries.push({
      name: path.basename(file),
      sha256: sha256(await readFile(file)),
    });
  }
  return contentIdentity(entries);
}

async function taskCodeIdentity(files: string[]): Promise<string> {
  const framework = [
    './calibration.ts',
    '../runner/task-workspace.ts',
    '../core/experiment.ts',
    '../core/deadline.ts',
    '../core/capture-policy.ts',
    '../core/identity.ts',
    '../core/mutation.ts',
    '../core/outcome.ts',
    '../core/reconstruction.ts',
    '../core/snapshot.ts',
    '../core/static-config.ts',
    '../core/task.ts',
    '../runner/docker-verifier.ts',
    '../runner/pnpm-tool.ts',
    '../core/model-profile.ts',
    '../core/task-bank.ts',
    '../tasks/banks.ts',
    '../tasks/v2/index.ts',
    '../tasks/v2_1/index.ts',
    '../tasks/v2_1/I01.ts',
    '../tasks/v2_1/I03.ts',
    '../tasks/v2_1/R02.ts',
    '../graders/v2_1/R02.ts',
    '../graders/v2_1/I03.ts',
    '../graders/v2_1/W03.ts',
    '../graders/v2/N01.ts',
  ].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  return codeIdentity([...new Set([...files, ...framework])]);
}

export async function writeFixture(
  files: Record<string, string>,
  directory: string,
) {
  await mkdir(directory, { mode: 0o700 });
  for (const [file, content] of Object.entries(files)) {
    assertRelativePath(file);
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content, {
      flag: 'wx',
      mode: 0o644,
    });
  }
}

/**
Every task uses the same controller-owned empty Skill root before treatment installation.
Dependency directories are created from the admitted closure after reconstruction.
*/
export async function prepareTaskStart(
  directory: string,
  skill: Snapshot | null = null,
) {
  await prepareTaskState(directory, skill);
}

/**
The same isolated Grader and monotonic deadline serve calibration and formal attempts.
*/
export async function gradeTaskProject(
  definition: TaskDefinition,
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  project: ReconstructedProject | null,
  docker: DockerIdentity,
  deadline: GradingDeadline,
): Promise<{
  report: AssertionReport;
  commands: CommandEvidence[];
  error?: string;
} | null> {
  if (!project) return null;
  const verifier = new DockerVerifier(docker, deadline);
  try {
    return await deadline.run(async () => {
      await verifier.start(project);
      const result = await definition.grade(task, fixture, final, verifier);
      return {
        report: verifier.commands.some(
          (command) => command.timedOut || command.exitCode === null,
        )
          ? { ...result.report, status: 'error' as const }
          : result.report,
        commands: verifier.commands,
      };
    });
  } catch (error) {
    return {
      report: {
        taskId: task.id,
        graderDigest: task.gradingContract.graderDigest,
        status: 'error',
        assertions: [],
      },
      commands: verifier.commands,
      error: error instanceof Error ? error.message : 'Unknown Grader failure',
    };
  } finally {
    await verifier.dispose();
  }
}

function validateCalibrationCases(definition: TaskDefinition): void {
  if (
    definition.cases.filter((value) => value.expected === 'passed').length ===
      0 ||
    definition.cases.filter((value) => value.expected !== 'passed').length ===
      0 ||
    new Set(definition.cases.map((value) => value.id)).size !==
      definition.cases.length
  )
    throw new Error(
      'Calibration needs a reference and distinct negative cases',
    );
  for (const value of definition.cases)
    if (!/^[a-z0-9-]+$/.test(value.id))
      throw new Error('Invalid calibration case ID');
}

async function applyCalibrationEdits(
  source: string,
  edits: CalibrationCase['edits'],
): Promise<void> {
  for (const edit of edits) {
    assertRelativePath(edit.path);
    const target = path.join(source, edit.path);
    if (edit.content === null)
      await rm(target, { recursive: true, force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, edit.content, { mode: 0o644 });
    }
    if (edit.mode !== undefined) await chmod(target, edit.mode);
  }
}

export async function calibrateTask(input: {
  definition: TaskDefinition;
  docker: DockerIdentity;
  closureDigest: string;
  output: string;
}) {
  const { definition, output } = input;
  if (
    !path.isAbsolute(output) ||
    (await realpath(path.dirname(output))) !== path.dirname(output)
  )
    throw new Error(
      'Calibration output must have a canonical controller parent',
    );
  validateCalibrationCases(definition);
  await mkdir(output, { mode: 0o700 });
  const codeDigest = await taskCodeIdentity(definition.sourceFiles);
  const graderDigest = await taskCodeIdentity(definition.graderFiles);
  const fixtureDirectory = path.join(output, 'fixture');
  await writeFixture(definition.files, fixtureDirectory);
  const fixture = await captureSnapshot(fixtureDirectory, 'F0');
  const identities = {
    closure: input.closureDigest,
    toolchain: contentIdentity(input.docker),
    grader: graderDigest,
  };
  const task = definition.createTask(fixture, identities);
  assertFixtureCaptureScope(task, fixture);
  if (
    task.id !== definition.id ||
    task.fixtureDigest !== fixture.digest ||
    task.installPlan.setupSteps.length > 0
  )
    throw new Error(
      'Task fixture or setup does not match this calibrated controller',
    );
  await writeFile(
    path.join(output, 'task.json'),
    JSON.stringify(task, null, 2),
    { mode: 0o600 },
  );
  await writeFile(path.join(output, 'F0.json'), JSON.stringify(fixture), {
    mode: 0o600,
  });
  const frozenTask = freezeTaskIdentity(
    task,
    contentIdentity({ codeDigest, setup: 'empty-skill-root-v1' }),
    contentIdentity(input.docker),
  );
  const results = [];
  for (const scenario of definition.cases) {
    const directory = path.join(output, scenario.id);
    await mkdir(directory);
    const source = path.join(directory, 'source');
    await materializeSnapshot(fixture, source);
    await prepareTaskStart(source);
    const start = await captureTaskSnapshot(source, 'S0', task);
    await applyCalibrationEdits(source, scenario.edits);
    const final = await captureTaskSnapshot(source, 'S1', task);
    await writeFile(path.join(directory, 'S0.json'), JSON.stringify(start), {
      mode: 0o600,
    });
    await writeFile(path.join(directory, 'S1.json'), JSON.stringify(final), {
      mode: 0o600,
    });
    const deadline = new GradingDeadline();
    const reconstructed = await reconstructForVerifier({
      task,
      fixture,
      start,
      final,
      destination: path.join(directory, 'reconstructed'),
      prepareStart: prepareTaskStart,
    });
    const grading = await gradeTaskProject(
      definition,
      task,
      fixture,
      final,
      reconstructed.project,
      input.docker,
      deadline,
    );
    const outcome = deriveOutcome(task, {
      execution: { status: 'completed', exitCode: 0 },
      captureStatus: final.status,
      traceStatus: 'complete',
      mutation: reconstructed.decision,
      grade: grading?.report ?? null,
    });
    // Calibration has controller edits and command evidence, never an Agent trace or usage.
    const isMatched =
      scenario.expected === 'passed'
        ? outcome.status === 'passed'
        : scenario.expected === 'unsafe'
          ? outcome.status === 'unsafe_mutation' && grading === null
          : outcome.status === 'assertion_failed';
    const isTargeted =
      (scenario.expectedFailedAssertions ?? []).every((id) =>
        grading?.report.assertions.some((a) => a.id === id && !a.passed),
      ) &&
      (scenario.expectedViolationCodes ?? []).every(
        (code) =>
          reconstructed.decision.status === 'unsafe' &&
          reconstructed.decision.violations.some((v) => v.code === code),
      );
    const result = {
      caseId: scenario.id,
      expected: scenario.expected,
      matched: isMatched && isTargeted,
      states: {
        fixture: fixture.digest,
        start: start.digest,
        final: final.digest,
      },
      outcome,
      mutation: reconstructed.decision,
      grading,
    };
    results.push(result);
    await writeFile(
      path.join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
  }
  if (
    (await taskCodeIdentity(definition.sourceFiles)) !== codeDigest ||
    (await taskCodeIdentity(definition.graderFiles)) !== graderDigest
  )
    throw new Error('Controller task code changed during calibration');
  const receipt = {
    version: 1,
    kind: 'controller-calibration',
    modelCalls: 0,
    formalAttempt: false,
    observedAt: new Date().toISOString(),
    task: frozenTask,
    codeDigest,
    graderDigest,
    docker: input.docker,
    closureDigest: input.closureDigest,
    casesDigest: contentIdentity(definition.cases),
    passed: results.every((result) => result.matched),
    results,
  };
  await writeFile(
    path.join(output, 'calibration.json'),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  return receipt;
}

function verifyCalibrationStates(
  result: Awaited<ReturnType<typeof calibrateTask>>['results'][number],
  fixture: Snapshot,
  start: Snapshot,
  final: Snapshot,
): void {
  if (
    result.states.fixture !== fixture.digest ||
    result.states.start !== start.digest ||
    result.states.final !== final.digest
  )
    throw new Error('Calibration state identity changed');
  if (
    start.status !== 'complete' ||
    final.status !== 'complete' ||
    start.stage !== 'S0' ||
    final.stage !== 'S1'
  )
    throw new Error('Calibration state evidence incomplete');
}

function verifyCalibrationFixture(
  fixture: Snapshot,
  definition: TaskDefinition,
): void {
  const expectedPaths = new Set(Object.keys(definition.files));
  for (const file of Object.keys(definition.files)) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++)
      expectedPaths.add(parts.slice(0, depth).join('/'));
  }
  if (
    fixture.excludedRoots.length > 0 ||
    fixture.entries.length !== expectedPaths.size ||
    fixture.entries.some(
      (entry) =>
        !expectedPaths.has(entry.path) ||
        (entry.kind === 'file'
          ? Buffer.from(entry.content, 'base64').toString('utf8') !==
              definition.files[entry.path] || entry.mode !== 0o644
          : entry.kind !== 'directory'),
    )
  )
    throw new Error(
      'Calibration fixture differs from the controller task definition',
    );
}

export interface AdmittedTask {
  readonly task: TaskSpec;
  readonly fixture: Snapshot;
  readonly identity: ReturnType<typeof freezeTaskIdentity>;
  readonly calibrationDirectory: string;
  readonly calibrationDigest: string;
  readonly definition: TaskDefinition;
}
const admittedTasks = new WeakSet<object>();

/**
Read the controller's complete calibration artifacts again before scheduling.
A green boolean alone is not admission evidence.
*/
export async function admitCalibratedTask(input: {
  definition: TaskDefinition;
  docker: DockerIdentity;
  closureDigest: string;
  directory: string;
}): Promise<AdmittedTask> {
  const { definition, directory } = input;
  if (!path.isAbsolute(directory) || (await realpath(directory)) !== directory)
    throw new Error('Calibration storage must be canonical');
  const read = async <T>(relative: string): Promise<T> => {
    assertRelativePath(relative);
    const file = path.join(directory, relative);
    if ((await realpath(file)) !== file)
      throw new Error('Calibration artifact alias rejected');
    return JSON.parse(await readFile(file, 'utf8')) as T;
  };
  const receipt =
    await read<Awaited<ReturnType<typeof calibrateTask>>>('calibration.json');
  const fixture = await read<Snapshot>('F0.json');
  const codeDigest = await taskCodeIdentity(definition.sourceFiles);
  const graderDigest = await taskCodeIdentity(definition.graderFiles);
  const task = definition.createTask(fixture, {
    closure: input.closureDigest,
    toolchain: contentIdentity(input.docker),
    grader: graderDigest,
  });
  const identity = freezeTaskIdentity(
    task,
    contentIdentity({ codeDigest, setup: 'empty-skill-root-v1' }),
    contentIdentity(input.docker),
  );
  if (
    receipt.version !== 1 ||
    receipt.kind !== 'controller-calibration' ||
    receipt.formalAttempt ||
    receipt.modelCalls !== 0 ||
    !receipt.passed ||
    receipt.codeDigest !== codeDigest ||
    receipt.graderDigest !== graderDigest ||
    receipt.closureDigest !== input.closureDigest ||
    contentIdentity(receipt.docker) !== contentIdentity(input.docker) ||
    receipt.casesDigest !== contentIdentity(definition.cases) ||
    contentIdentity(receipt.task) !== contentIdentity(identity) ||
    contentIdentity(await read<TaskSpec>('task.json')) !==
      contentIdentity(task) ||
    receipt.results.length !== definition.cases.length
  )
    throw new Error('Calibration identity changed or is incomplete');
  verifySnapshot(fixture);
  verifyCalibrationFixture(fixture, definition);
  async function verifyCase(scenario: CalibrationCase): Promise<void> {
    const result = receipt.results.find(
      (value) => value.caseId === scenario.id,
    );
    if (
      !result ||
      !result.matched ||
      contentIdentity(await read(`${scenario.id}/result.json`)) !==
        contentIdentity(result)
    )
      throw new Error('Calibration result evidence missing or changed');
    const start = await read<Snapshot>(`${scenario.id}/S0.json`);
    const final = await read<Snapshot>(`${scenario.id}/S1.json`);
    verifySnapshot(start);
    verifySnapshot(final);
    verifyCalibrationStates(result, fixture, start, final);
    if (
      (scenario.expectedFailedAssertions ?? []).some(
        (id) =>
          !result.grading?.report.assertions.some(
            (a) => a.id === id && !a.passed,
          ),
      )
    )
      throw new Error('Negative calibration failed for another assertion');
    const decision = validateMutations(task, start, final);
    if (
      (scenario.expectedViolationCodes ?? []).some(
        (code) =>
          decision.status !== 'unsafe' ||
          decision.violations.every((v) => v.code !== code),
      )
    )
      throw new Error('Negative calibration rejected for another reason');
    const outcome = deriveOutcome(task, {
      execution: { status: 'completed', exitCode: 0 },
      captureStatus: final.status,
      traceStatus: 'complete',
      mutation: decision,
      grade: result.grading?.report ?? null,
    });
    if (
      contentIdentity(decision) !== contentIdentity(result.mutation) ||
      contentIdentity(outcome) !== contentIdentity(result.outcome)
    )
      throw new Error('Calibration outcome disagrees with its evidence');
    if (
      scenario.expected === 'passed'
        ? outcome.status !== 'passed'
        : scenario.expected === 'unsafe'
          ? outcome.status !== 'unsafe_mutation' || result.grading !== null
          : outcome.status !== 'assertion_failed'
    )
      throw new Error('Calibration reference or negative control did not hold');
  }
  for (const scenario of definition.cases) await verifyCase(scenario);
  const admitted = Object.freeze({
    task,
    fixture,
    identity,
    calibrationDirectory: directory,
    calibrationDigest: contentIdentity(receipt),
    definition,
  });
  admittedTasks.add(admitted);
  return admitted;
}

export async function verifyAdmittedTask(
  task: AdmittedTask,
  docker: DockerIdentity,
  closureDigest: string,
) {
  if (!admittedTasks.has(task))
    throw new Error('Task has not passed controller calibration admission');
  const fresh = await admitCalibratedTask({
    definition: task.definition,
    directory: task.calibrationDirectory,
    docker,
    closureDigest,
  });
  if (
    fresh.calibrationDigest !== task.calibrationDigest ||
    contentIdentity(fresh.identity) !== contentIdentity(task.identity) ||
    contentIdentity(fresh.task) !== contentIdentity(task.task) ||
    contentIdentity(fresh.fixture) !== contentIdentity(task.fixture)
  )
    throw new Error('Admitted task changed before dispatch');
}
