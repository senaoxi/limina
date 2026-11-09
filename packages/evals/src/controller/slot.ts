import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { observeActivation } from '../core/activation.ts';
import type { BillingEvidence, BudgetManager } from '../core/budget.ts';
import { captureTaskSnapshot } from '../core/capture-policy.ts';
import { GradingDeadline } from '../core/deadline.ts';
import type {
  AgentExecution,
  AssertionReport,
  AttemptFacts,
} from '../core/outcome.ts';
import {
  materializeSnapshot,
  reconstructForVerifier,
} from '../core/reconstruction.ts';
import type {
  AttemptRecord,
  EvidenceReference,
  RunStore,
} from '../core/run-store.ts';
import { captureSnapshot, sha256, type Snapshot } from '../core/snapshot.ts';
import { runLocalCodex } from '../runner/attempt.ts';
import { taskTools } from '../runner/local-codex.ts';
import {
  installAgentRuntime,
  prepareTaskState,
} from '../runner/task-workspace.ts';
import { WorkspaceVolume } from '../runner/workspace-volume.ts';
import {
  type AdmittedTask,
  gradeTaskProject,
  verifyAdmittedTask,
} from './calibration.ts';
import type { FoundationPreflightConfig } from './preflight.ts';
import { verifyBinary } from './prepare.ts';

export const explicitInstruction =
  'Use the installed $limina skill for this task.';

async function checkVolumeParent(parent: string) {
  if ((await realpath(parent)) !== parent)
    throw new Error('Workspace volume parent must be canonical');
  for (let current = parent; ; current = path.dirname(current)) {
    for (const marker of ['.git', 'package.json']) {
      try {
        await lstat(path.join(current, marker));
        throw new Error(
          'Agent workspace cannot inherit a host Git repository or package manifest',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (path.dirname(current) === current) return;
  }
}
type Result = Awaited<ReturnType<typeof runLocalCodex>>;

/**
Called serially by the formal controller after suite, budget and stage admission.
*/
export async function executeSlot(input: {
  store: RunStore;
  admitted: AdmittedTask;
  config: FoundationPreflightConfig;
  skill: Snapshot | null;
  volumeParent: string;
  budget: BudgetManager;
  billing: BillingEvidence;
  assertDispatchAllowed: () => undefined;
  expectedSlotId?: string;
}) {
  const { store, admitted, config, skill } = input;
  const next = store.next();
  if (
    !next ||
    next.slot.taskId !== admitted.task.id ||
    (input.expectedSlotId && next.slot.id !== input.expectedSlotId)
  )
    throw new Error('Unexpected frozen slot');
  const treatment = store.manifest.inputs.conditions.find(
    (value) => value.id === next.slot.condition,
  );
  if (!treatment || treatment.skillDigest !== (skill?.digest ?? null))
    throw new Error('Slot treatment differs from frozen Skill');
  await verifyAdmittedTask(
    admitted,
    config.docker,
    config.runtimeBundle.digest,
  );
  await Promise.all(
    [config.node, config.pnpm, config.docker].map((binary) =>
      verifyBinary(binary),
    ),
  );
  await checkVolumeParent(input.volumeParent);
  const runId = `${next.slot.id}-${next.ordinal}`;
  let isClaimed = false;
  const began = performance.now();
  const root = await mkdtemp(path.join(store.directory, `${runId}-`));
  const evidenceName = path.basename(root);
  const save = (file: string, value: unknown) =>
    writeFile(path.join(root, file), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  const volume = new WorkspaceVolume(
    path.join(input.volumeParent, evidenceName),
  );
  let result: Result | null = null;
  const facts: AttemptFacts = {
    execution: { status: 'unknown' },
    captureStatus: 'unknown',
    traceStatus: 'unknown',
    mutation: null,
    grade: null,
  };
  let agentMs: number | null = null;
  let activation: AttemptRecord['activation'] = {
    installed: 'unknown',
    discovered: 'unknown',
    used: 'unknown',
  };
  const raw = path.join(root, 'raw');
  await save('F0.json', admitted.fixture);
  let isInterrupted = false;
  try {
    volume.create();
    await rmdir(volume.workspace); // Only the empty, newly created volume project.
    await materializeSnapshot(admitted.fixture, volume.workspace);
    const f0 = await captureSnapshot(volume.workspace, 'F0');
    if (f0.status !== 'complete' || f0.digest !== admitted.task.fixtureDigest)
      throw new Error('Materialized fixture changed');
    const runtime = await installAgentRuntime(
      admitted.task,
      config.runtimeBundle,
      volume.workspace,
    );
    await prepareTaskState(volume.workspace, skill);
    const expectedStart = path.join(root, 'expected-start');
    await materializeSnapshot(admitted.fixture, expectedStart);
    await prepareTaskState(expectedStart, skill);
    const expected = await captureTaskSnapshot(
      expectedStart,
      'S0',
      admitted.task,
    );
    if (!expected.digest || expected.status !== 'complete')
      throw new Error('Incomplete expected S0');
    const prompt =
      next.slot.condition === 'explicit-skill'
        ? `${explicitInstruction}\n${admitted.task.prompt}`
        : admitted.task.prompt;
    await save('prompt.json', { prompt });
    result = await runLocalCodex({
      runId,
      ...(store.manifest.inputs.modelProfile && {
        modelProfile: store.manifest.inputs.modelProfile,
        campaignId: store.manifest.inputs.campaignId!,
        experimentIdentity: store.manifest.identity,
        slotId: next.slot.id,
      }),
      onReserved: () => {
        if (
          store.startNext({ slotId: next.slot.id, ordinal: next.ordinal })
            ?.runId !== runId
        )
          throw new Error('Slot already claimed');
        isClaimed = true;
      },
      task: admitted.task,
      prompt,
      identity: config.codex,
      home: config.authHome,
      volume,
      runtime,
      evidenceDirectory: raw,
      ...taskTools(
        volume.workspace,
        config.node.executable,
        config.pnpm.executable,
      ),
      allowedSkillPaths: skill
        ? [path.join(volume.workspace, '.agents/skills/limina/SKILL.md')]
        : [],
      billing: input.billing,
      budget: input.budget,
      timeoutMs: store.manifest.policy.timeoutsMs.agent,
      setupEndsAt: began + store.manifest.policy.timeoutsMs.setup,
      expectedStartDigest: expected.digest,
      assertDispatchAllowed: input.assertDispatchAllowed,
    });
    agentMs = result.agentMs;
    Object.assign(facts, {
      execution: result.execution,
      captureStatus: result.s1.status,
      traceStatus: result.trace.status,
      mutation: result.mutation,
    });
    activation = {
      installed: skill ? 'yes' : 'no',
      discovered: skill ? 'unknown' : 'no',
      used: skill ? 'unknown' : 'no',
    };
    if (
      result.mutation.status === 'accepted' &&
      result.execution.status !== 'infra_error'
    ) {
      const deadline = new GradingDeadline(
        store.manifest.policy.timeoutsMs.grading,
      );
      const rebuilt = await reconstructForVerifier({
        task: admitted.task,
        fixture: admitted.fixture,
        start: result.s0,
        final: result.s1,
        destination: path.join(root, 'verifier'),
        prepareStart: (directory) => prepareTaskState(directory, skill),
      });
      if (!rebuilt.project)
        throw new Error('Accepted changes failed verifier reconstruction');
      await verifyBinary(config.docker);
      const grade = await gradeTaskProject(
        admitted.definition,
        admitted.task,
        admitted.fixture,
        result.s1,
        rebuilt.project,
        config.docker,
        deadline,
      );
      await save('assertions.json', grade);
      facts.grade = grade?.report ?? null;
    }
  } catch (error) {
    isInterrupted = true;
    await save('controller-error.json', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (result && facts.mutation?.status === 'accepted') {
      facts.grade = {
        taskId: admitted.task.id,
        graderDigest: admitted.task.gradingContract.graderDigest,
        status: 'error',
        assertions: [],
      } satisfies AssertionReport;
    } else {
      // A later parse or settlement error must not erase a known Agent failure.
      try {
        const exit: { execution: AgentExecution; agentMs: number } = JSON.parse(
          await readFile(path.join(raw, 'execution.json'), 'utf8'),
        );
        facts.execution = exit.execution;
        agentMs = exit.agentMs;
      } catch {
        /*
        No controller exit observation.
        */
      }
      try {
        const final: Snapshot = JSON.parse(
          await readFile(path.join(raw, 'S1.json'), 'utf8'),
        );
        facts.captureStatus = final.status;
      } catch {
        /*
        No final observation.
        */
      }
    }
  } finally {
    try {
      volume.detach();
    } catch (error) {
      isInterrupted = true;
      await save('detach-error.json', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!isClaimed)
    throw new Error(
      `Pre-dispatch stopped before model execution; slot remains not_run. See ${
        root
      }`,
    );
  const evidence: EvidenceReference[] = [];
  for (const [kind, file] of [
    ['fixture', 'F0.json'],
    ['start', 'raw/S0.json'],
    ['final', 'raw/S1.json'],
    ['trace', 'raw/native-trace-capture.json'],
    ['assertions', 'assertions.json'],
    ['infrastructure', 'raw/infrastructure.json'],
  ] as const) {
    try {
      const bytes = await readFile(path.join(root, file));
      evidence.push({
        kind,
        path: path.join(evidenceName, file),
        sha256: sha256(bytes),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const record = store.finish(runId, admitted.task, {
    facts,
    usage:
      facts.execution.status === 'infra_error' ? null : (result?.usage ?? null),
    time: { agentMs, endToEndMs: performance.now() - began },
    activation,
    evidence,
    ...(store.manifest.version === 2 &&
      result && {
        activationEvidence: observeActivation({
          skill,
          discoverable: result.skillDiscoverable,
          trace: result.traceFiles,
          traceComplete: result.trace.status === 'complete',
          evidence: evidence.filter(
            (entry) => entry.kind === 'trace' || entry.kind === 'start',
          ),
        }),
      }),
  });
  // Keep an incomplete capture's image for reconciliation; never delete a mounted image.
  if (
    !isInterrupted &&
    result?.s1.status === 'complete' &&
    result.runtimeIntegrity.status !== 'unknown'
  )
    await rm(volume.root, { recursive: true });
  if (isInterrupted)
    throw new Error('Controller interrupted; attempt saved, dispatch stopped');
  return record;
}
