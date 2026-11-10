import { classification } from './classification.ts';
import {
  admitPlan,
  artifactName,
  domains,
  files,
  jobName,
  plannedExecutions,
} from './contract.ts';
import { audit, executionOrigin } from './evidence.ts';
import { assertHead, contractHash, diff, isAncestor } from './git.ts';
import { GitHub, oneArtifact } from './github.ts';
import { History } from './history.ts';
import {
  hashObject,
  invariant,
  message,
  readJson,
  requiredEnvironment,
  writeJson,
} from './io.ts';
import type { ApiJob, ApiRun, JobReceipt, Plan, Receipt } from './types.ts';

export async function revalidateUnaffected(plan: Plan): Promise<void> {
  if (domains.every((domain) => plan.domains[domain].mode !== 'unaffected'))
    return;
  const resolved = await new History(
    new GitHub(plan.repository),
    plan,
  ).resolve();
  for (const domain of domains) {
    const entry = plan.domains[domain];
    if (entry.mode !== 'unaffected') continue;
    const checkpoint = resolved.checkpoints[domain];
    const proof = entry.proof;
    invariant(
      !resolved.mustRun.has(domain),
      'Later actual failure invalidates unaffected: ' + domain,
    );
    invariant(
      checkpoint.successfulSha === proof.checkpoint.successfulSha &&
        checkpoint.runId === proof.checkpoint.runId &&
        hashObject(checkpoint.executions) ===
          hashObject(proof.checkpoint.executions),
      'Checkpoint evidence changed: ' + domain,
    );
    invariant(
      isAncestor(
        checkpoint.successfulSha,
        plan.baseHistorySha || plan.targetSha,
      ),
      'Checkpoint outside admitted history',
    );
    const actual = diff(checkpoint.successfulSha, plan.targetSha);
    invariant(
      actual.diffDigest === proof.diffDigest &&
        hashObject(actual.paths) === hashObject(proof.paths),
      'Unaffected diff mismatch',
    );
    const raw: Record<string, string> = {};
    for (const [name, paths] of Object.entries(proof.filters)) {
      raw[name] = String(paths.length > 0);
      raw[name + '_count'] = String(paths.length);
      raw[name + '_files'] = JSON.stringify(paths);
    }
    const result = classification(actual.paths, raw);
    invariant(
      result.classificationDigest === proof.classificationDigest &&
        !result.affected.includes(domain) &&
        result.filters.full_control!.length === 0,
      'Invalid unaffected policy proof',
    );
  }
}
export async function currentAudit(plan: Plan): Promise<Receipt> {
  assertHead(plan.targetSha);
  invariant(
    contractHash(plan.targetSha, plan.rollingNode) === plan.contractHash,
    'Current contract mismatch',
  );
  const api = new GitHub(plan.repository, 180_000);
  const run = await api.run(plan.runId);
  invariant(
    run.repository.id === plan.repositoryId &&
      run.repository.full_name === plan.repository &&
      run.path === '.github/workflows/ci.yml' &&
      run.event === plan.event &&
      run.run_attempt === Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
    'Current Run does not match plan',
  );
  invariant(
    plan.workflowId === run.workflow_id ||
      (plan.workflowId === 0 && plan.mode === 'full'),
    'Workflow ID mismatch',
  );
  const attempts = new Map<number, ApiJob[]>();
  for (
    let attempt = Math.max(plan.originAttempt, run.run_attempt - 29);
    attempt <= run.run_attempt;
    attempt++
  )
    attempts.set(attempt, await api.jobs(run.id, attempt));
  const jobs = attempts.get(run.run_attempt)!;
  const planners = jobs.filter((job) => job.name === 'Plan');
  invariant(
    planners.length === 1 && planners[0]!.conclusion === 'success',
    'Planner did not succeed',
  );
  invariant(
    executionOrigin(planners[0]!, attempts).attempt === plan.originAttempt,
    'Frozen Plan source mismatch',
  );
  const artifacts = await api.artifacts(run.id);
  const receipts: JobReceipt[] = [];
  const names = new Set<string>();
  for (const item of plannedExecutions(plan)) {
    const matches = jobs.filter(
      (job) => job.name === jobName(item.job, item.tuple, item.shard),
    );
    if (matches.length !== 1 || matches[0]!.conclusion === 'skipped') continue;
    const origin = executionOrigin(matches[0]!, attempts);
    names.add(
      artifactName(
        'receipt',
        origin.attempt,
        item.job + '-' + item.tuple,
        item.shard,
      ),
    );
  }
  for (const name of names) {
    const matches = artifacts.filter(
      (artifact) => artifact.name === name && !artifact.expired,
    );
    invariant(matches.length <= 1, 'Ambiguous execution receipt artifact');
    if (matches[0])
      receipts.push(
        await api.jsonArtifact<JobReceipt>(matches[0], 'receipt.json'),
      );
  }
  const receipt = audit(plan, { jobs, attempts, receipts }, run.run_attempt);
  receipt.workflowId = run.workflow_id;
  try {
    await revalidateUnaffected(plan);
  } catch (error) {
    receipt.errors.push(message(error));
    receipt.state = 'failure';
  }
  return receipt;
}
export async function status(): Promise<void> {
  const plan = admitPlan(readJson(files.plan));
  const receipt = await currentAudit(plan);
  writeJson(files.audit, receipt);
  invariant(receipt.state === 'candidate', receipt.errors.join('\n'));
}
export async function validatePublication(
  run: ApiRun,
  target: string,
): Promise<void> {
  const api = new GitHub(requiredEnvironment('GITHUB_REPOSITORY'), 180_000);
  invariant(
    run.head_sha === target &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.path === '.github/workflows/ci.yml' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.repository.full_name === api.repository,
    'Release requires successful exact main push SHA',
  );
  const latest = await api.get<{ workflow_runs: ApiRun[] }>(
    '/actions/workflows/ci.yml/runs?' +
      new URLSearchParams({
        head_sha: target,
        event: 'push',
        branch: 'main',
        per_page: '1',
      }),
  );
  invariant(
    latest.workflow_runs[0]?.id === run.id &&
      latest.workflow_runs[0]?.run_attempt === run.run_attempt &&
      latest.workflow_runs[0]?.conclusion === 'success',
    'Release gate Run changed',
  );
  const artifacts = await api.artifacts(run.id);
  const receipt = await api.jsonArtifact<Receipt>(
    oneArtifact(artifacts, artifactName('audit', run.run_attempt)),
    'audit.json',
  );
  invariant(
    receipt.schema === 1 &&
      receipt.state === 'candidate' &&
      receipt.errors.length === 0 &&
      receipt.runId === run.id &&
      receipt.viewAttempt === run.run_attempt &&
      receipt.targetSha === target &&
      receipt.workflowId === run.workflow_id &&
      receipt.repositoryId === run.repository.id &&
      receipt.repository === api.repository &&
      receipt.event === 'push' &&
      receipt.ref === 'refs/heads/main',
    'Release receipt identity mismatch',
  );
  invariant(
    Date.now() - Date.parse(receipt.createdAt) <= 30 * 86_400_000 &&
      Date.parse(receipt.createdAt) <= Date.now(),
    'Release receipt expired',
  );
  const planCandidates = artifacts.filter(
    (artifact) =>
      /^ci-plan-a\d+-all-all$/.test(artifact.name) && !artifact.expired,
  );
  let plan: Plan | undefined;
  for (const artifact of planCandidates) {
    const candidate = admitPlan(
      await api.jsonArtifact<Plan>(artifact, 'plan.json'),
    );
    if (candidate.planHash !== receipt.planHash) {
      continue;
    }

    invariant(!plan, 'Ambiguous release Plan');
    plan = candidate;
  }
  invariant(
    plan &&
      plan.targetSha === target &&
      plan.runId === run.id &&
      plan.contractHash === receipt.contractHash &&
      contractHash(target, plan.rollingNode) === receipt.contractHash,
    'Release contract mismatch',
  );
  const view = await new History(api, plan).view(run);
  const actual = audit(plan, view, run.run_attempt);
  invariant(
    actual.state === 'candidate' &&
      hashObject(actual.domains) === hashObject(receipt.domains),
    'Release execution inventory mismatch',
  );
  const statusJobs = view.jobs.filter((job) => job.name === 'CI Status');
  invariant(
    statusJobs.length === 1 && statusJobs[0]!.conclusion === 'success',
    'CI Status is not successful',
  );
  await revalidateUnaffected(plan);
}
