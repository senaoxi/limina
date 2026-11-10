import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BillingEvidence, BudgetManager } from '../core/budget.ts';
import { captureRoots, captureTaskSnapshot } from '../core/capture-policy.ts';
import { contentIdentity } from '../core/identity.ts';
import {
  type ModelProfile,
  verifyProfileBinary,
} from '../core/model-profile.ts';
import { validateMutations } from '../core/mutation.ts';
import type { TaskSpec } from '../core/task.ts';
import {
  beforeCaptureDeadline,
  executeCapturedProcess,
} from './captured-process.ts';
import {
  codexEnvironment,
  type CodexIdentity,
  inspectAccount,
  localCodexArguments,
  prepareCodexHome,
  verifyLocalConfig,
  verifyPromptInput,
} from './local-codex.ts';
import { collectNativeTrace } from './native-trace.ts';
import {
  type AgentRuntimeReceipt,
  ProtectedRuntimeChanged,
  verifyAgentRuntime,
} from './task-workspace.ts';
import { usageFromEvents } from './usage.ts';
import type { WorkspaceVolume } from './workspace-volume.ts';

interface AttemptInput {
  runId: string;
  task: TaskSpec;
  prompt: string;
  identity: CodexIdentity;
  modelProfile?: ModelProfile;
  campaignId?: string;
  experimentIdentity?: string;
  slotId?: string;
  home: string;
  volume: WorkspaceVolume;
  runtime: AgentRuntimeReceipt;
  evidenceDirectory: string;
  readableToolRoots: string[];
  toolDirectories: string[];
  allowedSkillPaths?: string[];
  billing: BillingEvidence;
  budget: BudgetManager;
  /**
  Synchronous controller gate, rechecked after asynchronous preparation.
  */
  assertDispatchAllowed: () => undefined;
  timeoutMs?: number;
  /**
  Controller monotonic deadline, including account and native discovery checks.
  */
  setupEndsAt?: number;
  expectedStartDigest?: string;
  onReserved?: () => void;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function protectInputs(input: AttemptInput): void {
  const workspace = realpathSync(input.volume.workspace);
  const protectedPaths = [
    path.join(input.home, '.codex'),
    input.evidenceDirectory,
    input.budget.path,
    input.volume.image,
  ];
  for (const protectedPath of protectedPaths) {
    if (isWithin(workspace, protectedPath))
      throw new Error('Controller data must be outside the Agent workspace');
    for (const root of input.readableToolRoots)
      if (isWithin(realpathSync(root), protectedPath))
        throw new Error('Tool read permission exposes protected data');
  }
}

function assertIncludedAccount(
  billing: BillingEvidence,
  account: Awaited<ReturnType<typeof inspectAccount>>,
): void {
  if (
    billing.mode !== 'included_only' ||
    !['plus', 'pro', 'prolite', 'promax'].includes(
      account.auth.planType ?? '',
    ) ||
    account.ordinaryUsageAllowed !== true ||
    account.credits?.balance !== '0' ||
    account.credits.hasCredits ||
    account.credits.unlimited ||
    account.spendControlReached !== false
  )
    throw new Error(
      'This runner is admitted only for included usage without credits',
    );
}

function assertPreparedRuntime(
  input: AttemptInput,
  excludedRoots: string[],
): void {
  if (
    input.task.dependencyPolicy.variants.every(
      (variant) => variant.closureDigest !== input.runtime.bundleDigest,
    ) ||
    contentIdentity(input.runtime.links) !==
      contentIdentity(input.task.installPlan.projectLinks ?? []) ||
    contentIdentity(input.runtime.readOnlyRoots) !==
      contentIdentity(
        excludedRoots.filter(
          (root) => root === 'node_modules' || root.endsWith('/node_modules'),
        ),
      )
  )
    throw new Error('Prepared runtime does not match the frozen TaskSpec');
}

async function prepareNativeAccount(
  input: AttemptInput,
  environment: ReturnType<typeof codexEnvironment>,
  readableToolRoots: string[],
) {
  const discovery = await inspectAccount(
    input.identity,
    environment,
    {
      workspace: input.volume.workspace,
      disabledSkillPaths: [],
    },
    input.modelProfile,
  );
  const allowedSkillPaths = input.allowedSkillPaths ?? [];
  for (const skillPath of allowedSkillPaths)
    if (!isWithin(input.volume.workspace, realpathSync(skillPath)))
      throw new Error('Treatment Skill must be frozen inside the workspace');
  const disabledSkillPaths = (discovery.skills ?? [])
    .filter((skill) => !allowedSkillPaths.includes(skill.path))
    .map((skill) => skill.path);
  const account = await inspectAccount(
    input.identity,
    environment,
    {
      workspace: input.volume.workspace,
      disabledSkillPaths,
    },
    input.modelProfile,
  );
  const enabledSkillPaths = (account.skills ?? [])
    .filter((skill) => skill.enabled)
    .map((skill) => skill.path);
  verifyLocalConfig(
    input.identity,
    input.evidenceDirectory,
    readableToolRoots,
    disabledSkillPaths,
    input.volume.workspace,
    input.modelProfile,
  );
  if (
    enabledSkillPaths.length !== allowedSkillPaths.length ||
    enabledSkillPaths.some(
      (skillPath) => !allowedSkillPaths.includes(skillPath),
    )
  )
    throw new Error('Native Skill discovery differs from the frozen treatment');
  if (
    account.model?.model !==
      (input.modelProfile?.canonicalModelId ?? 'gpt-6.1-terra') ||
    account.model.supportedReasoningEfforts.every(
      (effort) =>
        effort.reasoningEffort !==
        (input.modelProfile?.reasoningEffort ?? 'high'),
    )
  )
    throw new Error('Required model and reasoning effort unavailable');
  assertIncludedAccount(input.billing, account);
  return { discovery, account, allowedSkillPaths, disabledSkillPaths };
}

async function checkRuntimeIntegrity(
  input: AttemptInput,
  s0: Awaited<ReturnType<typeof captureTaskSnapshot>>,
  s1: Awaited<ReturnType<typeof captureTaskSnapshot>>,
  captureEndsAt: number,
) {
  let mutation = validateMutations(input.task, s0, s1);
  let runtimeIntegrity: {
    status: 'complete' | 'changed' | 'unknown';
    error?: string;
  } = {
    status: 'unknown',
  };
  if (s1.status === 'complete') {
    try {
      await beforeCaptureDeadline(captureEndsAt, () =>
        verifyAgentRuntime(input.volume.frozen, input.runtime),
      );
      runtimeIntegrity = { status: 'complete' };
    } catch (error) {
      runtimeIntegrity = {
        status:
          error instanceof ProtectedRuntimeChanged ? 'changed' : 'unknown',
        error:
          error instanceof Error
            ? error.message
            : 'Runtime integrity capture failed',
      };
      if (error instanceof ProtectedRuntimeChanged) {
        const violations =
          mutation.status === 'unsafe' ? mutation.violations : [];
        mutation = {
          status: 'unsafe',
          violations: [
            ...violations,
            { path: error.relativePath, code: 'protected' },
          ],
        };
      }
    }
  }
  if (runtimeIntegrity.status === 'unknown' && mutation.status === 'accepted')
    mutation = {
      status: 'unknown',
      reason: 'Protected dependency evidence is incomplete',
    };
  return { mutation, runtimeIntegrity };
}

/**
Every launched model attempt reserves one slot in the same controller ledger.
Final capture runs for success, nonzero exit, timeout and process errors alike.
*/
export async function runLocalCodex(input: AttemptInput) {
  if (input.modelProfile)
    verifyProfileBinary(input.modelProfile, input.identity);
  input.assertDispatchAllowed();
  const excludedRoots = captureRoots(input.task);
  assertPreparedRuntime(input, excludedRoots);
  await verifyAgentRuntime(input.volume.workspace, input.runtime);
  const readableToolRoots = [
    ...input.readableToolRoots,
    ...excludedRoots
      .filter(
        (root) => root !== 'node_modules' && root.endsWith('/node_modules'),
      )
      .map((root) => path.join(input.volume.workspace, root)),
  ];
  protectInputs(input);
  mkdirSync(input.evidenceDirectory, { mode: 0o700 });
  const clientHome = path.join(input.evidenceDirectory, 'client-home');
  mkdirSync(clientHome, { mode: 0o700 });
  const temporary = path.join(input.volume.workspace, '.eval-tmp');
  mkdirSync(temporary, { recursive: true });
  // :tmpdir denies the control process's temporary directory. The shell uses
  // its own workspace directory through the frozen invocation overrides.
  const clientTemporary = path.join(clientHome, 'tmp');
  mkdirSync(clientTemporary, { mode: 0o700 });
  const environment = codexEnvironment(
    input.home,
    clientTemporary,
    input.toolDirectories,
    clientHome,
  );
  const isolatedHome = prepareCodexHome(input.home, environment);
  try {
    const nativeTraceRoot = path.join(input.evidenceDirectory, 'native-trace');
    mkdirSync(nativeTraceRoot, { mode: 0o700 });
    // The pinned CLI writes raw tool dispatches here, outside all Agent grants.
    // exec --json alone omits some Code Mode tool outputs.
    environment.CODEX_ROLLOUT_TRACE_ROOT = nativeTraceRoot;
    const { discovery, account, allowedSkillPaths, disabledSkillPaths } =
      await prepareNativeAccount(input, environment, readableToolRoots);
    const s0 = await captureTaskSnapshot(
      input.volume.workspace,
      'S0',
      input.task,
    );
    writeFileSync(
      path.join(input.evidenceDirectory, 'S0.json'),
      `${JSON.stringify(s0)}\n`,
      { mode: 0o600 },
    );
    if (s0.status !== 'complete')
      throw new Error('Cannot launch without complete S0');
    if (input.expectedStartDigest && s0.digest !== input.expectedStartDigest)
      throw new Error(
        'Prepared Agent start differs from controller reconstruction',
      );
    const billing = {
      ...input.billing,
      observedAt: account.observedAt,
      settingsObservedAt:
        input.billing.settingsObservedAt ?? input.billing.observedAt,
      accountPlan: account.auth.planType ?? 'unknown',
      unlimitedCredits: account.credits?.unlimited ?? true,
      ordinaryUsageAllowed: account.ordinaryUsageAllowed,
      creditBalance: 0,
    };
    const instructions = verifyPromptInput(
      input.identity,
      environment,
      input.volume.workspace,
      input.prompt,
      readableToolRoots,
      disabledSkillPaths,
      input.modelProfile,
    );
    writeFileSync(
      path.join(input.evidenceDirectory, 'instructions.json'),
      `${JSON.stringify(instructions)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    isolatedHome.assertClean();
    if (
      input.setupEndsAt !== undefined &&
      performance.now() >= input.setupEndsAt
    )
      throw new Error('Setup deadline expired before model dispatch');
    // No asynchronous work may separate this final admission from reservation,
    // slot claim and process creation. A stop raised during setup leaves the
    // slot not_run and creates no budget reservation or model request.
    input.assertDispatchAllowed();
    const dispatchAdmittedAt = new Date().toISOString();
    input.budget.reserveAttempt({
      runId: input.runId,
      taskId: input.task.id,
      model: input.modelProfile?.canonicalModelId ?? 'gpt-6.1-terra',
      reasoningEffort: input.modelProfile?.reasoningEffort ?? 'high',
      ...(input.modelProfile
        ? {
            modelProfile: input.modelProfile,
            campaignId: input.campaignId!,
            experimentIdentity: input.experimentIdentity!,
            slotId: input.slotId!,
            serviceTier: input.modelProfile.requestedServiceTier,
          }
        : { speed: 'standard' as const }),
      maximumUsd: 0,
      estimatedUsd: null,
      billing,
    });
    input.onReserved?.();
    const argv = localCodexArguments(
      input.volume.workspace,
      readableToolRoots,
      disabledSkillPaths,
      input.modelProfile,
    );
    writeFileSync(
      path.join(input.evidenceDirectory, 'invocation.json'),
      `${JSON.stringify({ identity: input.identity, argv, account, dispatchAdmittedAt, startedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    const { execution, agentMs, s1, events, captureEndsAt } =
      await executeCapturedProcess({
        identity: input.identity,
        args: argv,
        environment,
        stdin: input.prompt,
        volume: input.volume,
        evidenceDirectory: input.evidenceDirectory,
        excludedRoots,
        timeoutMs: input.timeoutMs,
      });
    async function finalizeAttempt() {
      // Preserve a known exit independently of later trace, billing and Grader work.
      writeFileSync(
        path.join(input.evidenceDirectory, 'execution.json'),
        JSON.stringify({ execution, agentMs }),
        { mode: 0o600, flag: 'wx' },
      );
      const usage = usageFromEvents(events);
      const starts = events.filter(
        (event): event is { type: string; thread_id: string } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'thread.started' &&
          'thread_id' in event &&
          typeof event.thread_id === 'string',
      );
      const trace = await collectNativeTrace(
        nativeTraceRoot,
        starts.length === 1 ? starts[0]!.thread_id : null,
        usage,
        input.modelProfile,
        { forbidAgentInstructions: true },
      );
      writeFileSync(
        path.join(input.evidenceDirectory, 'native-trace-capture.json'),
        `${JSON.stringify({ ...trace, skillDiscovery: { authority: 'codex-app-server:skills/list', modelProfileId: input.modelProfile?.id ?? null, workspace: input.volume.workspace, before: { observedAt: discovery.observedAt, skills: discovery.skills }, dispatch: { observedAt: account.observedAt, skills: account.skills } } })}\n`,
        { mode: 0o600 },
      );
      usage.modelEvidence = {
        observedModelIds: trace.evidence.observedModelIds ?? [],
        modelProfileId: input.modelProfile?.id ?? null,
        traceDigest: trace.files.digest,
      };
      if (
        trace.evidence.status !== 'complete' ||
        !trace.evidence.tokensComplete
      ) {
        usage.complete = false;
        usage.settlement = 'unknown';
        usage.settledUsd = null;
      }
      if (execution.status === 'infra_error')
        input.budget.recordNotDispatched(
          input.runId,
          execution.evidence.recordId,
        );
      else input.budget.recordUsage(input.runId, usage);
      const { mutation, runtimeIntegrity } = await checkRuntimeIntegrity(
        input,
        s0,
        s1,
        captureEndsAt,
      );
      const result = {
        runId: input.runId,
        taskId: input.task.id,
        execution,
        agentMs,
        s0,
        s1,
        usage,
        trace: trace.evidence,
        runtime: input.runtime,
        runtimeIntegrity,
        mutation,
        skillDiscoverable: allowedSkillPaths.length === 1,
        traceFiles: trace.files,
      };
      writeFileSync(
        path.join(input.evidenceDirectory, 'attempt.json'),
        `${JSON.stringify(result)}\n`,
        { mode: 0o600 },
      );
      return result;
    }
    return await finalizeAttempt();
  } finally {
    isolatedHome.dispose();
  }
}
