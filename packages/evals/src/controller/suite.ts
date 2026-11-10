import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  createExperiment,
  type ExperimentInputs,
  taskCatalog,
} from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import type { DockerIdentity } from '../runner/docker-verifier.ts';
import {
  admitCalibratedTask,
  type AdmittedTask,
  type TaskDefinition,
  verifyAdmittedTask,
} from './calibration.ts';

interface CalibrationInput {
  definition: TaskDefinition;
  directory: string;
  docker: DockerIdentity;
  closureDigest: string;
}
export interface AdmittedSuite {
  readonly identity: string;
  readonly tasks: readonly AdmittedTask[];
  readonly calibrations: readonly CalibrationInput[];
  readonly sealedStore: string;
  readonly repository: string;
}
const suites = new WeakSet<object>();
const isWithin = (root: string, file: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);

/**
Formal smoke is gated by the whole frozen 17/9 suite, not just its I01 example.
Sealed bodies and grading/reference code must be held outside the repository.
Skill revision process/mount/network isolation remains a separate runtime gate.
*/
export async function admitTaskSuite(input: {
  calibrations: CalibrationInput[];
  sealedStore: string;
  repository: string;
}): Promise<AdmittedSuite> {
  if (
    input.calibrations.length !== taskCatalog.length ||
    taskCatalog.some(
      (task) =>
        input.calibrations.filter((item) => item.definition.id === task.id)
          .length !== 1,
    )
  )
    throw new Error(
      'Formal execution requires all 26 calibrated tasks, with the frozen 17/9 split',
    );
  for (const directory of [input.sealedStore, input.repository])
    if (
      !path.isAbsolute(directory) ||
      (await realpath(directory)) !== directory
    )
      throw new Error('Suite storage roots must be canonical');
  if (
    isWithin(input.repository, input.sealedStore) ||
    isWithin(input.sealedStore, input.repository)
  )
    throw new Error(
      'Sealed controller storage must be separate from the repository',
    );
  const tasks = [];
  for (const calibration of input.calibrations) {
    const metadata = taskCatalog.find(
      (task) => task.id === calibration.definition.id,
    )!;
    if (metadata.split === 'sealed') {
      const privatePaths = [
        calibration.directory,
        ...calibration.definition.sourceFiles,
        ...calibration.definition.graderFiles,
      ];
      for (const file of privatePaths)
        if (!isWithin(input.sealedStore, await realpath(file)))
          throw new Error(
            'Sealed task, Grader and reference code must stay in controller storage',
          );
    }
    const task = await admitCalibratedTask(calibration);
    if (
      task.task.split !== metadata.split ||
      task.task.domain !== metadata.domain
    )
      throw new Error('Task moved across the frozen split or domain');
    tasks.push(task);
  }
  const identity = contentIdentity(
    tasks.map((task) => ({
      identity: task.identity,
      calibrationDigest: task.calibrationDigest,
    })),
  );
  const suite = Object.freeze({
    identity,
    tasks: Object.freeze(tasks),
    calibrations: Object.freeze([...input.calibrations]),
    sealedStore: input.sealedStore,
    repository: input.repository,
  });
  suites.add(suite);
  return suite;
}

export async function freezeAdmittedExperiment(
  suite: AdmittedSuite,
  input: Omit<ExperimentInputs, 'tasks' | 'imageDigest'>,
) {
  if (!suites.has(suite))
    throw new Error('Suite has not passed controller admission');
  // Recheck even the tasks outside the requested batch before freezing a formal plan.
  for (const task of suite.tasks) {
    const calibration = suite.calibrations.find(
      (value) => value.definition.id === task.task.id,
    )!;
    await verifyAdmittedTask(
      task,
      calibration.docker,
      calibration.closureDigest,
    );
  }
  if (
    contentIdentity(
      suite.tasks.map((task) => ({
        identity: task.identity,
        calibrationDigest: task.calibrationDigest,
      })),
    ) !== suite.identity
  )
    throw new Error('Admitted suite identity changed');
  const tasks = suite.tasks
    .filter((task) =>
      input.kind === 'smoke'
        ? task.task.id === 'I01'
        : input.kind === 'pilot'
          ? [
              'I01',
              'C01',
              'R02',
              'K01',
              'S01',
              'W02',
              'T01',
              'P01',
              'N01',
            ].includes(task.task.id)
          : input.kind === 'confirmation' ||
            task.task.split ===
              (input.kind === 'development' ? 'dev' : 'sealed'),
    )
    .map((task) => task.identity);
  if (input.modelProfile) tasks.sort((a, b) => a.id.localeCompare(b.id));
  return createExperiment({
    ...input,
    tasks,
    imageDigest: contentIdentity(
      suite.calibrations.map((value) => value.docker.image),
    ),
    contextDigest: contentIdentity({
      context: input.contextDigest,
      calibratedSuite: suite.identity,
    }),
  });
}
