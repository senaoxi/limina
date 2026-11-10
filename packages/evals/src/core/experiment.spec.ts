import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createExperiment,
  type ExperimentInputs,
  freezeTaskIdentity,
  taskCatalog,
  verifyExperiment,
} from './experiment.ts';
import { contentIdentity } from './identity.ts';
import type { TaskSpec } from './task.ts';

function taskSpec(id: string): TaskSpec {
  const metadata = taskCatalog.find((task) => task.id === id)!;
  return {
    ...metadata,
    version: 2,
    prompt: `Synthetic offline task ${id}`,
    fixtureDigest: contentIdentity({ fixture: id }),
    capturePolicy: { excludedRoots: [], requiredRoots: [] },
    mutationPolicy: { rules: [], protectedRoots: [] },
    dependencyPolicy: {
      inputs: [],
      variants: [
        {
          id: 'empty',
          inputsDigest: contentIdentity([]),
          closureDigest: contentIdentity({ dependencies: [] }),
        },
      ],
    },
    installPlan: {
      toolchainDigest: contentIdentity({ toolchain: 'fixture' }),
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: contentIdentity({ grader: id }),
      requiredAssertions: ['semantic'],
    },
  };
}

function inputs(kind: ExperimentInputs['kind']): ExperimentInputs {
  return {
    kind,
    seed: 'preregistered-seed',
    preparedInputsDigest: contentIdentity('product'),
    runnerDigest: contentIdentity('runner'),
    toolchainDigest: contentIdentity('tools'),
    contextDigest: contentIdentity('context'),
    imageDigest: contentIdentity('image'),
    tasks: taskCatalog
      .filter((task) =>
        kind === 'smoke'
          ? task.id === 'I01'
          : kind === 'confirmation' ||
            task.split === (kind === 'development' ? 'dev' : 'sealed'),
      )
      .map((task) =>
        freezeTaskIdentity(
          taskSpec(task.id),
          contentIdentity('setup'),
          contentIdentity('grading-tools'),
        ),
      ),
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: contentIdentity('skill') },
      ...(kind === 'smoke'
        ? [
            {
              id: 'explicit-skill' as const,
              skillDigest: contentIdentity('skill'),
            },
          ]
        : kind === 'confirmation'
          ? [
              {
                id: 'candidate' as const,
                skillDigest: contentIdentity('candidate'),
              },
            ]
          : []),
    ],
  };
}

test('preregisters every independent repetition and rejects shortened or altered batches', () => {
  for (const [kind, expected] of [
    ['smoke', 3],
    ['development', 102],
    ['sealed', 54],
    ['confirmation', 234],
  ] as const) {
    const input = inputs(kind);
    const plan = createExperiment(input);
    verifyExperiment(plan);
    assert.equal(plan.slots.length, expected);
    assert.equal(new Set(plan.slots.map((slot) => slot.id)).size, expected);
    assert.deepEqual(createExperiment(input), plan);
    const shortened = structuredClone(input);
    shortened.tasks.pop();
    assert.throws(() => createExperiment(shortened), /inventory/);
    const duplicate = structuredClone(input);
    duplicate.conditions[1] = duplicate.conditions[0]!;
    assert.throws(() => createExperiment(duplicate), /Conditions/);
    const tampered = structuredClone(plan);
    tampered.slots.pop();
    assert.throws(() => verifyExperiment(tampered), /identity changed/);
  }
});

test('comparison excludes only the declared Skill treatment and never explicit activation or tool drift', () => {
  const input = inputs('development');
  const original = createExperiment(input);
  const first = original.slots.filter((slot) => slot.block === 'I01:1');
  assert.equal(first[0]!.comparisonIdentity, first[1]!.comparisonIdentity);
  assert.notEqual(first[0]!.executionIdentity, first[1]!.executionIdentity);
  const changedSkill = structuredClone(input);
  changedSkill.conditions[1]!.skillDigest = contentIdentity(
    'reference-only edit',
  );
  const changed = createExperiment(changedSkill);
  const skillBefore = first.find((slot) => slot.condition === 'skill')!;
  const skillAfter = changed.slots.find(
    (slot) => slot.block === 'I01:1' && slot.condition === 'skill',
  )!;
  assert.notEqual(skillBefore.executionIdentity, skillAfter.executionIdentity);
  assert.equal(skillBefore.comparisonIdentity, skillAfter.comparisonIdentity);
  const changedTools = createExperiment({
    ...input,
    toolchainDigest: contentIdentity('different tools'),
  });
  assert.notEqual(
    original.slots[0]!.comparisonIdentity,
    changedTools.slots[0]!.comparisonIdentity,
  );
  const smoke = createExperiment(inputs('smoke'));
  assert.notEqual(
    smoke.slots.find((slot) => slot.condition === 'skill')!.comparisonIdentity,
    smoke.slots.find((slot) => slot.condition === 'explicit-skill')!
      .comparisonIdentity,
  );
});

test('grading fixes produce a separate grading identity while old slot manifests remain immutable', () => {
  const input = inputs('development');
  const original = createExperiment(input);
  const revised = taskSpec('I01');
  revised.gradingContract.graderDigest = contentIdentity('corrected grader');
  const updated = {
    ...input,
    tasks: input.tasks.map((task) =>
      task.id === 'I01'
        ? freezeTaskIdentity(
            revised,
            contentIdentity('setup'),
            contentIdentity('grading-tools'),
          )
        : task,
    ),
  };
  const rescoring = createExperiment(updated);
  const before = original.slots.find(
    (slot) => slot.taskId === 'I01' && slot.condition === 'base',
  )!;
  const after = rescoring.slots.find(
    (slot) => slot.taskId === 'I01' && slot.condition === 'base',
  )!;
  assert.equal(before.executionIdentity, after.executionIdentity);
  assert.notEqual(before.gradingIdentity, after.gradingIdentity);
  assert.notEqual(before.comparisonIdentity, after.comparisonIdentity);
  assert.notEqual(before.id, after.id);
  assert.equal(
    original.inputs.tasks.find((task) => task.id === 'I01')!.specDigest,
    contentIdentity(taskSpec('I01')),
  );
});
