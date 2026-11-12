import { existsSync, lstatSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { type BillingEvidence, BudgetManager } from '../core/budget.ts';
import {
  campaignExperiment,
  type CampaignManifest,
  verifyCampaign,
} from '../core/campaign.ts';
import {
  type BatchKind,
  type ConditionId,
  type ExperimentManifest,
  taskCatalog,
} from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { RunStore } from '../core/run-store.ts';
import {
  captureSnapshot,
  compareAgentSnapshots,
  sha256,
  type Snapshot,
  verifySnapshot,
} from '../core/snapshot.ts';
import {
  type BankRevision,
  createTaskBank,
  isBankRevision,
} from '../core/task-bank.ts';
import { localCodexArguments } from '../runner/local-codex.ts';
import { developmentTasksForRevision } from '../tasks/banks.ts';
import type { TaskDefinition } from './calibration.ts';
import {
  foundationPreflight,
  type FoundationPreflightConfig,
  verifyPreparedInputs,
} from './preflight.ts';
import { projectDevelopmentDiagnostics } from './revision-export.ts';
import { bindRunBudget } from './run-budget.ts';
import { executeSlot, explicitInstruction } from './slot.ts';
import { admitTaskSuite, freezeAdmittedExperiment } from './suite.ts';

export interface FileReference {
  file: string;
  sha256: string;
}
export interface RuntimeAdmission {
  name: string;
  config: FileReference;
  review: FileReference;
  artifacts: FileReference[];
  closure: string;
  image: string;
}
export interface Decision {
  developmentIdentity: string;
  decision: 'retain' | 'revise';
  developmentEvidence: FileReference;
  frozenAt: string;
  candidate?: {
    directory: string;
    digest: string;
    exportManifest: FileReference;
    start: FileReference;
    final: FileReference;
    revisionRunId: string;
    nativeTrace: FileReference;
  };
}
export interface Admission {
  version: 1;
  seed: string;
  campaign?: string;
  bankRevision?: BankRevision;
  taskCalibration?: FileReference;
  repository: string;
  sealedStore: string;
  volumeParent: string;
  calibrationIndex: FileReference;
  runtimes: RuntimeAdmission[];
  revision: {
    manifest: FileReference;
    isolation: FileReference;
    workspace: string;
  };
  billing: FileReference;
  decision?: FileReference;
}
export async function pinned(reference: FileReference) {
  if (
    !reference ||
    !path.isAbsolute(reference.file) ||
    (await realpath(reference.file)) !== reference.file
  )
    throw new Error('Admission evidence missing or aliased');
  const bytes = await readFile(reference.file);
  if (sha256(bytes) !== reference.sha256)
    throw new Error('Frozen controller evidence changed');
  return bytes;
}
function isWithin(root: string, child: string) {
  return child === root || child.startsWith(root + path.sep);
}
export async function owned(file: string) {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file)
    throw new Error('Controller path must be canonical');
  const stat = await lstat(file);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new Error(
      'Controller input is not exclusively controlled by its owner',
    );
}
async function json<T>(reference: FileReference): Promise<T> {
  const bytes = await pinned(reference);
  return JSON.parse(bytes.toString('utf8')) as T;
}
async function runnerDigest() {
  const files = [
    'cli',
    'controller/formal',
    'controller/slot',
    'controller/run-budget',
    'controller/suite',
    'controller/calibration',
    'controller/preflight',
    'controller/prepare',
    'controller/revision-export',
    'core/experiment',
    'core/model-profile',
    'core/task-bank',
    'core/campaign',
    'core/activation',
    'core/attribution',
    'core/campaign-report',
    'controller/campaign',
    'controller/campaign-smoke',
    'controller/publication',
    'controller/task-bank',
    'tasks/banks',
    'tasks/v2/index',
    'tasks/v2_1/index',
    'tasks/v2_2/index',
    'graders/v2_2/I01',
    'graders/v2_2/K01',
    'graders/v2_2/K03',
    'graders/v2_2/P01',
    'graders/v2_2/R02',
    'graders/v2_2/S02',
    'graders/v2_2/W02',
    'graders/v2_2/workflow-command',

    'tasks/v2_1/I01',
    'tasks/v2_1/I03',
    'tasks/v2_1/R02',
    'graders/v2_1/R02',
    'graders/v2_1/I03',
    'graders/v2_1/W03',
    'graders/v2/N01',
    'core/capture-policy',
    'core/budget',
    'core/identity',
    'core/mutation',
    'core/outcome',
    'core/deadline',
    'core/reconstruction',
    'core/run-store',
    'core/snapshot',
    'core/task',
    'core/static-config',
    'runner/attempt',
    'runner/captured-process',
    'runner/docker-verifier',
    'runner/local-codex',
    'runner/pnpm-tool',
    'runner/native-trace',
    'runner/usage',
    'runner/task-workspace',
    'runner/workspace-volume',
  ];
  return contentIdentity(
    await Promise.all(
      files.map(async (file) => ({
        file,
        sha256: sha256(
          await readFile(new URL(`../${file}.ts`, import.meta.url)),
        ),
      })),
    ),
  );
}
export async function reviewedRuntime(input: RuntimeAdmission) {
  const config = await json<FoundationPreflightConfig>(input.config);
  if (
    config.runtimeBundle.digest !== input.closure ||
    config.docker.image !== input.image ||
    input.artifacts.length === 0
  )
    throw new Error('Runtime does not match the reviewed closure and image');
  await owned(input.review.file);
  const review = await json<{
    status: string;
    closure: string;
    image: string;
    artifactsDigest: string;
    licenseDecision?: FileReference;
  }>(input.review);
  if (
    review.status !== 'admitted' ||
    review.closure !== input.closure ||
    review.image !== input.image ||
    review.artifactsDigest !== contentIdentity(input.artifacts)
  )
    throw new Error(`Dependency admission incomplete for ${input.name}`);
  for (const reference of input.artifacts) await pinned(reference);
  if (input.name === 'framework') {
    if (!review.licenseDecision)
      throw new Error('Explicit maintainer MPL review missing');
    await owned(review.licenseDecision.file);
    const ruling = await json<{
      decision: string;
      scope: string;
      closure: string;
      maintainerSource: string;
      package: string;
    }>(review.licenseDecision);
    if (
      ruling.decision !== 'approved' ||
      ruling.scope !== 'unchanged-private-local-no-distribution' ||
      ruling.closure !== input.closure ||
      ruling.package !== 'lightningcss@1.33.0' ||
      !ruling.maintainerSource?.trim()
    )
      throw new Error(
        'Maintainer decision does not cover the exact private framework runtime',
      );
  }
  return config;
}

export async function verifyIsolation(
  input: Admission,
  developmentIdentities: string[],
  preparedIdentity: string,
  config: FoundationPreflightConfig,
) {
  const manifest = await json<{
    identity: string;
    preparedIdentity: string;
    developmentIdentities: string[];
    workspaceDigest: string;
  }>(input.revision.manifest);
  const { identity, ...body } = manifest;
  const current = await captureSnapshot(input.revision.workspace, 'S0');
  const report = await json<{
    modelCalls: number;
    exportIdentity: string;
    requests: number;
    profile: string[];
    observations: {
      id: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }[];
  }>(input.revision.isolation);
  const rounds = [
    'direct-and-parent-denial',
    'git-object-and-alias-denial',
    'independent-runtime-network-and-docker',
  ];
  const profile = localCodexArguments(input.revision.workspace, [
    config.runtimeBundle.directory,
    path.dirname(config.node.executable),
    '/System/Library/OpenSSL',
  ]);
  if (
    identity !== contentIdentity(body) ||
    current.status !== 'complete' ||
    current.digest !== manifest.workspaceDigest ||
    manifest.preparedIdentity !== preparedIdentity ||
    contentIdentity(manifest.developmentIdentities) !==
      contentIdentity(
        developmentIdentities.toSorted((a, b) => a.localeCompare(b)),
      ) ||
    report.modelCalls !== 0 ||
    report.exportIdentity !== identity ||
    report.requests !== 0 ||
    contentIdentity(report.profile) !== contentIdentity(profile) ||
    report.observations.length !== 3 ||
    report.observations
      .find((x) => x.id === rounds[0])
      ?.stderr.split('\n')
      .filter((line) =>
        /^cat:.*: (?:Operation not permitted|Permission denied)$/.test(line),
      ).length !== 4 ||
    report.observations.find((x) => x.id === rounds[1])?.stdout.trim() !==
      'GIT_OBJECT_DENIED' ||
    report.observations.find((x) => x.id === rounds[2])?.stdout.trim() !==
      'NETWORK_AND_DOCKER_DENIED' ||
    rounds.some(
      (id) =>
        report.observations.filter((x) => x.id === id && x.exitCode === 0)
          .length !== 1,
    )
  )
    throw new Error(
      'Revision isolation evidence differs from current export, tasks or sandbox',
    );
  return identity;
}
async function previousStage(root: string, expected: ExperimentManifest) {
  const directory = path.join(root, expected.inputs.kind);
  await owned(path.join(directory, 'manifest.json')); // Never create a missing prerequisite.
  const store = RunStore.open(directory);
  if (contentIdentity(store.manifest) !== contentIdentity(expected))
    throw new Error('Previous stage identity changed');
  const status = store.summary();
  if (
    status.inFlight ||
    status.slots.some(
      (s) =>
        !s.selected ||
        s.evidenceStatus !== 'complete' ||
        !s.selected.usage ||
        (expected.inputs.kind === 'smoke' && !s.selected.usage.complete),
    )
  )
    throw new Error('Previous stage lacks complete attempts and usage');
  if (
    expected.inputs.kind === 'smoke' &&
    status.slots.some(
      (s) =>
        !s.selected?.outcome.isValidAttempt ||
        (expected.version === 2 && s.selected.outcome.status !== 'passed') ||
        s.selected.facts.execution.status !== 'completed' ||
        s.selected.facts.execution.exitCode !== 0 ||
        s.selected.facts.grade?.status !== 'complete' ||
        s.selected.facts.traceStatus !== 'complete' ||
        s.selected.facts.mutation?.status !== 'accepted' ||
        s.selected.facts.mutation.changes.length === 0,
    )
  )
    throw new Error(
      'Smoke did not demonstrate real edits, trace and independent grading for every condition',
    );
  return store;
}

async function admitRuntimes(control: Admission) {
  const configs = new Map<string, FoundationPreflightConfig>();
  for (const name of ['base', 'vue', 'migration', 'framework']) {
    const matches = control.runtimes.filter((r) => r.name === name);
    if (matches.length !== 1 || control.runtimes.length !== 4)
      throw new Error('Four exact runtime admissions required');
    configs.set(name, await reviewedRuntime(matches[0]!));
  }
  const base = configs.get('base')!;
  const toolIdentity = (c: FoundationPreflightConfig) =>
    contentIdentity([
      c.controllerDirectory,
      c.preparedDirectory,
      c.authHome,
      c.codex,
      c.node,
      c.pnpm,
      c.docker.executable,
      c.docker.sha256,
      c.docker.endpoint,
    ]);
  if (configs.values().some((c) => toolIdentity(c) !== toolIdentity(base)))
    throw new Error('Runtime profiles disagree on shared inputs');
  return { base, configs };
}
async function admitDefinitions(
  control: Admission,
  configs: Map<string, FoundationPreflightConfig>,
) {
  if (!isWithin(control.sealedStore, control.calibrationIndex.file))
    throw new Error('Calibration index must be private');
  const index = await json<{
    results: {
      id: string;
      runtime: string;
      directory: string;
      closureDigest: string;
      docker: unknown;
    }[];
  }>(control.calibrationIndex);
  const calibrations = [];
  for (const item of index.results) {
    const meta = taskCatalog.find((t) => t.id === item.id);
    const runtime =
      item.id === 'K02'
        ? 'framework'
        : item.id === 'K01'
          ? 'vue'
          : item.id === 'W03'
            ? 'migration'
            : 'base';
    if (!meta || item.runtime !== runtime)
      throw new Error('Invalid calibration inventory');
    const config = configs.get(runtime)!;
    if (
      item.closureDigest !== config.runtimeBundle.digest ||
      contentIdentity(item.docker) !== contentIdentity(config.docker)
    )
      throw new Error('Calibrated and reviewed runtimes differ');
    let definition: TaskDefinition;
    if (meta.split === 'sealed') {
      const moduleFile = path.join(control.sealedStore, meta.id, 'task.ts');
      await owned(moduleFile);
      const module = await import(pathToFileURL(moduleFile).href);
      definition = module.definition;
    } else
      definition = developmentTasksForRevision(
        control.bankRevision ?? 'v1',
      ).find((t) => t.id === meta.id)!;
    if (definition.id !== item.id)
      throw new Error('Task module identity mismatch');
    calibrations.push({
      definition,
      directory: item.directory,
      docker: config.docker,
      closureDigest: item.closureDigest,
    });
  }
  const suite = await admitTaskSuite({
    calibrations,
    repository: control.repository,
    sealedStore: control.sealedStore,
  });
  return { index, suite };
}
async function admitCandidate(
  decision: Decision,
  original: Snapshot,
  developmentIdentity: string,
  preparedIdentity: string,
  budget: BudgetManager,
) {
  if (
    !decision.candidate ||
    decision.candidate.digest === original.digest ||
    !decision.candidate.revisionRunId
  )
    throw new Error('Missing independent revision and frozen candidate');
  const change = decision.candidate;
  const exported = await json<{
    identity: string;
    developmentRunIdentity: string;
    workspaceDigest: string;
    preparedIdentity: string;
    skillDigest: string;
  }>(change.exportManifest);
  const { identity: exportId, ...exportBody } = exported;
  const before = await json<Snapshot>(change.start);
  const after = await json<Snapshot>(change.final);
  const changes = compareAgentSnapshots(before, after);
  function verifyRevisionExport(): void {
    if (
      exportId !== contentIdentity(exportBody) ||
      exported.developmentRunIdentity !== developmentIdentity ||
      exported.preparedIdentity !== preparedIdentity ||
      exported.skillDigest !== original.digest ||
      before.digest !== exported.workspaceDigest ||
      before.excludedRoots.length > 0 ||
      changes.length === 0 ||
      changes.some(
        (c) =>
          !c.path.startsWith('skills/limina/') ||
          c.after?.kind === 'symlink' ||
          (c.after && (c.after.mode & 0o7000) !== 0),
      )
    )
      throw new Error(
        'Candidate includes changes outside the authorized revision export',
      );
  }
  verifyRevisionExport();
  const revisionAttempt = budget
    .summary()
    .attempts.find((a) => a.reservation.runId === change.revisionRunId);
  const usage = revisionAttempt?.usage;
  const trace = await json<{
    evidence: {
      status: string;
      threadId: string;
      digest: string;
      tokens: { input: number; output: number; cachedInput: number };
    };
    files: Snapshot;
  }>(change.nativeTrace);
  verifySnapshot(trace.files);
  if (
    !revisionAttempt ||
    revisionAttempt.notDispatchedEvidence !== null ||
    revisionAttempt.reservation.maximumUsd !== 0 ||
    revisionAttempt.reservation.billing.mode !== 'included_only' ||
    !usage?.complete ||
    trace.evidence.status !== 'complete' ||
    !trace.evidence.threadId ||
    trace.evidence.digest !== trace.files.digest ||
    trace.evidence.tokens.input !== usage.inputTokens ||
    trace.evidence.tokens.output !== usage.outputTokens ||
    trace.evidence.tokens.cachedInput !== usage.cachedInputTokens
  )
    throw new Error('Candidate lacks independently budgeted revision trace');
  const candidate = await captureSnapshot(change.directory, 'F0');
  const prefix = 'skills/limina/';
  const entries = after.entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  if (contentIdentity(entries) !== contentIdentity(candidate.entries))
    throw new Error('Candidate does not match the captured revision patch');
  if (
    candidate.status !== 'complete' ||
    candidate.digest !== decision.candidate.digest
  )
    throw new Error('Candidate changed after freeze');
  return candidate;
}

function assertFormalControl(
  control: Admission,
  controlFile: string,
  mode: 'input' | 'legacy-dispatch',
): void {
  if (
    control.bankRevision !== undefined &&
    !isBankRevision(control.bankRevision)
  )
    throw new Error('Unsupported task bank revision');
  if (
    mode === 'legacy-dispatch' &&
    control.bankRevision !== undefined &&
    control.bankRevision !== 'v1'
  )
    throw new Error(
      `${control.bankRevision.toUpperCase()} dispatch requires a Campaign and frozen Model Profile`,
    );
  if (
    control.version !== 1 ||
    !control.seed?.trim() ||
    !isWithin(control.sealedStore, controlFile) ||
    isWithin(control.repository, control.sealedStore) ||
    isWithin(control.volumeParent, control.sealedStore) ||
    isWithin(control.sealedStore, control.volumeParent)
  )
    throw new Error(
      'Formal plan must be held in independent controller storage',
    );
  if (
    control.campaign !== undefined &&
    (typeof control.campaign !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(control.campaign))
  )
    throw new Error('Campaign must be a single controlled path segment');
  if (
    control.bankRevision !== undefined &&
    control.bankRevision !== 'v1' &&
    !control.taskCalibration
  )
    throw new Error(
      `Independent ${control.bankRevision.toUpperCase()} task calibration is required before model admission`,
    );
}

export async function loadFormalInputs(
  controlFile: string,
  mode: 'input' | 'legacy-dispatch' = 'input',
) {
  await owned(controlFile);
  const control: Admission = JSON.parse(await readFile(controlFile, 'utf8'));
  assertFormalControl(control, controlFile, mode);
  await owned(control.sealedStore);
  await owned(control.volumeParent);
  const stopFile = path.join(control.sealedStore, 'formal', 'STOP');
  const assertDispatchAllowed = (): undefined => {
    try {
      lstatSync(stopFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error(
      'Controller dispatch stopped; remaining slots stay not_run',
    );
  };
  assertDispatchAllowed();
  const { base, configs } = await admitRuntimes(control);
  const { index, suite } = await admitDefinitions(control, configs);
  const prepared = await verifyPreparedInputs(base.preparedDirectory);
  const isolation = await verifyIsolation(
    control,
    suite.tasks
      .filter((t) => t.task.split === 'dev')
      .map((t) => contentIdentity(t.identity)),
    prepared.identity,
    base,
  );
  const billing = await json<BillingEvidence>(control.billing);
  if (
    billing.mode !== 'included_only' ||
    !billing.autoReloadDisabled ||
    billing.creditBalance !== 0 ||
    !billing.source
  )
    throw new Error(
      'Only documented included-only billing with auto-reload disabled is admitted',
    );
  const budget = new BudgetManager(
    path.join(base.controllerDirectory, 'budget.jsonl'),
  );
  const code = await runnerDigest();
  const original = await captureSnapshot(
    path.join(base.preparedDirectory, 'source/skills/limina'),
    'F0',
  );
  if (
    original.status !== 'complete' ||
    original.digest !== prepared.skillDigest
  )
    throw new Error('Frozen Skill changed');
  const common = {
    seed: control.seed,
    preparedInputsDigest: prepared.identity,
    runnerDigest: code,
    toolchainDigest: contentIdentity(control.runtimes.map((r) => r.config)),
    contextDigest: contentIdentity({
      isolation,
      runtimes: control.runtimes,
      billing: control.billing,
      campaign: control.campaign ?? null,
      explicitInstruction,
    }),
  };
  return {
    control,
    assertDispatchAllowed,
    base,
    configs,
    index,
    suite,
    prepared,
    isolation,
    billing,
    budget,
    code,
    original,
    common,
  };
}

export async function prepareFormalExecution(
  kind: BatchKind,
  controlFile: string,
  totalUsd: number,
  count: number,
  options: {
    campaign?: CampaignManifest;
    profileId?: string;
    decision?: { reference: FileReference; value: Decision };
  } = {},
) {
  const required = {
    smoke: 3,
    pilot: 18,
    development: 102,
    sealed: 54,
    confirmation: 234,
  };
  if (
    totalUsd !== 100 ||
    !Object.hasOwn(required, kind) ||
    count !== required[kind]
  )
    throw new Error(
      'Explicit global USD 100 cap and full preregistered slot count required',
    );
  const {
    control,
    assertDispatchAllowed,
    base,
    configs,
    index,
    suite,
    billing,
    budget,
    code,
    original,
    common,
    prepared,
  } = await loadFormalInputs(
    controlFile,
    options.campaign ? 'input' : 'legacy-dispatch',
  );
  function bindCampaignInputs(): void {
    if (!options.campaign) return;
    verifyCampaign(options.campaign);
    const campaign = options.campaign;
    const bank = createTaskBank(
      control.bankRevision ?? 'v1',
      suite.tasks.map((t) => ({ task: t.task, identity: t.identity })),
    );
    if (
      bank.id !== campaign.bank.id ||
      suite.identity !== campaign.suiteAdmissionId ||
      common.preparedInputsDigest !== campaign.common.preparedInputsDigest ||
      original.digest !== campaign.skillDigest
    )
      throw new Error('Campaign frozen inputs changed');
    const profile = campaign.profiles.find((p) => p.id === options.profileId);
    if (!profile) throw new Error('Profile not in campaign');
    for (const [name, config] of configs)
      configs.set(name, { ...config, modelProfile: profile });
  }
  bindCampaignInputs();
  async function verifyTaskCalibration(): Promise<void> {
    if (
      control.bankRevision !== 'v2' &&
      control.bankRevision !== 'v2.1' &&
      control.bankRevision !== 'v2.2'
    )
      return;
    const edition = control.bankRevision.toUpperCase();
    const review = await json<{
      bankId: string;
      status: string;
      referenceAccess: boolean;
      reviewerMode: string;
      tasks: { id: string; status: string; evidence: FileReference }[];
    }>(control.taskCalibration!);
    const bank = createTaskBank(
      control.bankRevision,
      suite.tasks.map((t) => ({ task: t.task, identity: t.identity })),
    );
    if (
      review.bankId !== bank.id ||
      review.status !== 'passed' ||
      review.referenceAccess ||
      review.reviewerMode !== 'independent' ||
      review.tasks.length !== 26 ||
      taskCatalog.some(
        (t) =>
          review.tasks.filter((r) => r.id === t.id && r.status === 'passed')
            .length !== 1,
      )
    )
      throw new Error(`Independent ${edition} task calibration is incomplete`);
    for (const task of review.tasks) await pinned(task.evidence);
  }
  await verifyTaskCalibration();
  const runRoot = path.join(
    control.sealedStore,
    'formal',
    control.campaign ?? '',
    ...(options.campaign ? [options.campaign.id, options.profileId!] : []),
  );
  await mkdir(runRoot, { mode: 0o700, recursive: true });
  await owned(runRoot);
  let candidate: Snapshot | null = null;
  const plan = async (stage: BatchKind) => {
    const ids: ConditionId[] =
      stage === 'smoke'
        ? ['base', 'skill', 'explicit-skill']
        : stage === 'confirmation'
          ? ['base', 'skill', 'candidate']
          : ['base', 'skill'];
    const frozen = await freezeAdmittedExperiment(suite, {
      ...common,
      kind: stage,
      conditions: ids.map((id) => ({
        id,
        skillDigest:
          id === 'base'
            ? null
            : id === 'candidate'
              ? (candidate?.digest ?? null)
              : original.digest,
      })),
      ...(options.campaign && {
        modelProfile: options.campaign.profiles.find(
          (p) => p.id === options.profileId,
        )!,
        bank: options.campaign.bank,
        campaignId: options.campaign.id,
        commonContractId: options.campaign.commonContractId,
      }),
    });
    if (options.campaign) {
      const expected = campaignExperiment(
        options.campaign,
        options.profileId!,
        stage,
        candidate?.digest ?? undefined,
      );
      if (contentIdentity(expected) !== contentIdentity(frozen))
        throw new Error('Campaign and formal experiment disagree');
    }
    return frozen;
  };
  if (kind !== 'smoke') await previousStage(runRoot, await plan('smoke'));
  async function admitFinalStage(): Promise<void> {
    const development = await previousStage(runRoot, await plan('development'));
    if (!control.decision && !options.decision)
      throw new Error(
        'Final stage requires a frozen development-only decision',
      );
    const decision =
      options.decision?.value ?? (await json<Decision>(control.decision!));
    if (
      decision.developmentIdentity !== development.manifest.identity ||
      decision.decision !== (kind === 'sealed' ? 'retain' : 'revise') ||
      !Number.isFinite(Date.parse(decision.frozenAt)) ||
      Date.parse(decision.frozenAt) > Date.now() ||
      development
        .summary()
        .attempts.some(
          (a) => Date.parse(a.completedAt) > Date.parse(decision.frozenAt),
        )
    )
      throw new Error(
        'Revision decision does not follow the completed development batch',
      );
    const diagnostics = projectDevelopmentDiagnostics(
      development,
      suite.tasks.filter((t) => t.task.split === 'dev'),
    );
    if (
      contentIdentity(await json(decision.developmentEvidence)) !==
      contentIdentity(diagnostics)
    )
      throw new Error('Decision cites different development evidence');
    if (kind === 'confirmation')
      candidate = await admitCandidate(
        decision,
        original,
        development.manifest.identity,
        prepared.identity,
        budget,
      );
    // No choosing another final branch on resume after seeing sealed results.
    const choice = path.join(runRoot, 'final-choice.json');
    const frozen = JSON.stringify({
      kind,
      decision: options.decision?.reference ?? control.decision,
    });
    try {
      await writeFile(choice, frozen, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(choice, 'utf8')) !== frozen
      )
        throw error;
    }
  }
  if (kind === 'confirmation' || kind === 'sealed') await admitFinalStage();
  const manifest = await plan(kind);
  const store = new RunStore(path.join(runRoot, kind), manifest);
  await bindRunBudget(store, budget.path);
  async function prepareDispatch(): Promise<void> {
    if (!store.next()) return;
    const financial = budget.summary();
    if (
      !financial.includedDispatchReady ||
      financial.remainingAuthorization < financial.reserve ||
      financial.totalLimit !== 100 ||
      billing.mode !== 'included_only'
    )
      throw new Error(
        'Cannot fund the entire registered batch under included-only dispatch',
      );
    const planned = store
      .summary()
      .slots.filter((s) => s.status === 'not_run').length;
    const forecast = await mkdtemp(
      path.join(store.directory, 'dispatch-budget-'),
    );
    await writeFile(
      path.join(forecast, 'forecast.json'),
      JSON.stringify({
        observedAt: new Date().toISOString(),
        totalLimitUsd: 100,
        reserveUsd: financial.reserve,
        remainingAuthorizationUsd: financial.remainingAuthorization,
        actualRemainingUsd: financial.remainingBudget,
        committedUsd: financial.committedSpend,
        settledUsd: financial.settledSpend,
        financialUnknownRecords: financial.financialUnknownRecords,
        planned,
        additionalUsdMaximum: 0,
        billingMode: billing.mode,
        providerCreditConversion: null,
        source:
          'included-only; dispatch stops at allowance exhaustion; no paid fallback',
      }),
      { mode: 0o600, flag: 'wx' },
    );
    for (const config of configs.values()) {
      const parent = await mkdtemp(
        path.join(base.controllerDirectory, 'formal-preflight-'),
      );
      const report = await foundationPreflight(
        config,
        path.join(parent, 'checks'),
      );
      if (report.status !== 'passed')
        throw new Error(`Formal preflight blocked: ${parent}`);
    }
  }
  await prepareDispatch();
  const dispatchNext = async (expectedSlotId?: string) => {
    if (existsSync(path.join(store.directory, 'MODEL_HOLD.json')))
      throw new Error('Model identity hold requires explicit evidence review');
    const next = store.next();
    if (!next || (expectedSlotId && next.slot.id !== expectedSlotId))
      throw new Error('Frozen campaign slot changed');
    assertDispatchAllowed();
    if ((await runnerDigest()) !== code)
      throw new Error('Runner changed since experiment freeze');
    const id = next.slot.taskId;
    const config = configs.get(
      index.results.find((r) => r.id === id)!.runtime,
    )!;
    const record = await executeSlot({
      store,
      expectedSlotId: next.slot.id,
      admitted: suite.tasks.find((t) => t.task.id === id)!,
      config,
      volumeParent: control.volumeParent,
      skill:
        next.slot.condition === 'base'
          ? null
          : next.slot.condition === 'candidate'
            ? candidate
            : original,
      budget,
      billing,
      assertDispatchAllowed,
    });
    if (
      record.facts.execution.status === 'infra_error' &&
      budget
        .summary()
        .attempts.some(
          (a) =>
            a.reservation.runId === record.runId &&
            a.notDispatchedEvidence ===
              record.evidence.find((r) => r.kind === 'infrastructure')?.sha256,
        )
    )
      return record;
    if (
      manifest.version === 2 &&
      record.observedModelId !== manifest.policy.model
    ) {
      await writeFile(
        path.join(store.directory, 'MODEL_HOLD.json'),
        `${JSON.stringify({
          runId: record.runId,
          expectedProfile: manifest.inputs.modelProfile!.id,
          reason: 'model_evidence_incomplete_or_mismatched',
        })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      throw new Error('Model evidence mismatch: profile held, usage preserved');
    }
    if (
      !record.usage ||
      (kind === 'smoke' && !record.usage.complete) ||
      !budget.summary().includedDispatchReady
    )
      throw new Error(
        'Required smoke usage or included-only policy unresolved: stop dispatch',
      );
    return record;
  };
  return {
    store,
    budget,
    dispatchNext,
    profileId: options.profileId ?? null,
    preparedIdentity: prepared.identity,
  };
}

export async function executeFormal(
  kind: BatchKind,
  controlFile: string,
  totalUsd: number,
  count: number,
) {
  const { store, dispatchNext } = await prepareFormalExecution(
    kind,
    controlFile,
    totalUsd,
    count,
  );
  for (let next = store.next(); next; next = store.next())
    await dispatchNext(next.slot.id);
  return {
    directory: store.directory,
    identity: store.manifest.identity,
    slots: store.manifest.slots.length,
    attempts: store.summary().attempts.length,
  };
}
