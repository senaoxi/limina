import {
  admitPlan,
  domains,
  jobName,
  plannedExecutions,
  stepName,
} from './contract.ts';
import { hashObject, invariant, message } from './io.ts';
import type {
  ApiJob,
  Domain,
  DomainResult,
  Execution,
  JobReceipt,
  Origin,
  Plan,
  Receipt,
  RunView,
} from './types.ts';

function fingerprint(job: ApiJob): string {
  return hashObject({
    name: job.name,
    started: job.started_at,
    completed: job.completed_at,
    conclusion: job.conclusion,
    steps: job.steps,
  });
}
export function executionOrigin(
  job: ApiJob,
  attempts: Map<number, ApiJob[]>,
): { attempt: number; job: ApiJob } {
  const matches: { attempt: number; job: ApiJob }[] = [];
  const ordered = [...attempts].sort(([a], [b]) => a - b);
  for (const [attempt, jobs] of ordered) {
    const candidates = jobs.filter(
      (candidate) =>
        candidate.name === job.name &&
        fingerprint(candidate) === fingerprint(job),
    );
    invariant(
      candidates.length <= 1,
      'Ambiguous execution source; rerun all jobs',
    );
    if (candidates[0]) matches.push({ attempt, job: candidates[0] });
  }
  invariant(matches[0], 'Unknown execution source; rerun all jobs');
  return matches[0];
}
export function jobReceipt(
  plan: Plan,
  item: Execution,
  originAttempt: number,
  receipts: JobReceipt[],
): JobReceipt {
  const matches = receipts.filter(
    (receipt) =>
      receipt.job === item.job &&
      receipt.tuple === item.tuple &&
      receipt.shard === item.shard &&
      receipt.executionAttempt === originAttempt,
  );
  invariant(matches.length === 1, 'Missing or ambiguous execution receipt');
  const receipt = matches[0]!;
  invariant(
    receipt.schema === 1 &&
      receipt.repository === plan.repository &&
      receipt.runId === plan.runId &&
      receipt.targetSha === plan.targetSha &&
      receipt.planHash === plan.planHash &&
      receipt.contractHash === plan.contractHash,
    'Execution receipt identity mismatch',
  );
  return receipt;
}
export function evaluateExecution(
  plan: Plan,
  item: Execution,
  view: Pick<RunView, 'jobs' | 'attempts' | 'receipts'>,
): Origin {
  const matches = view.jobs.filter(
    (job) => job.name === jobName(item.job, item.tuple, item.shard),
  );
  invariant(
    matches.length === 1,
    'Missing or ambiguous required Job: ' +
      jobName(item.job, item.tuple, item.shard),
  );
  const job = matches[0]!;
  invariant(
    job.status === 'completed' &&
      !['cancelled', 'skipped', 'timed_out'].includes(job.conclusion || ''),
    'Required Job did not complete',
  );
  const origin = executionOrigin(job, view.attempts);
  const receipt = jobReceipt(plan, item, origin.attempt, view.receipts);
  let execution: Origin | undefined;
  for (const key of [...item.prerequisites, item.step]) {
    const steps = job.steps.filter((step) => step.name === stepName(key));
    invariant(steps.length === 1, 'Missing required Step: ' + key);
    const step = steps[0]!;
    invariant(
      step.status === 'completed' &&
        step.conclusion === 'success' &&
        receipt.steps[key]?.outcome === 'success' &&
        receipt.steps[key]?.conclusion === 'success',
      'Required Step did not succeed: ' + key,
    );
    invariant(
      step.started_at && step.completed_at,
      'Missing actual execution timestamps',
    );
    if (key === item.step)
      execution = {
        jobKey: item.job,
        tuple: item.tuple,
        shard: item.shard,
        stepKey: key,
        originAttempt: origin.attempt,
        originJobId: origin.job.id,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        outcome: 'success',
      };
  }
  if (item.artifact) {
    const manifests = receipt.artifacts.filter(
      (artifact) =>
        artifact.kind === item.artifact && artifact.tuple === item.tuple,
    );
    invariant(manifests.length === 1, 'Missing consumed artifact provenance');
    const manifest = manifests[0]!;
    invariant(
      manifest.targetSha === plan.targetSha &&
        manifest.planHash === plan.planHash &&
        manifest.contractHash === plan.contractHash &&
        manifest.repository === plan.repository &&
        manifest.runId === plan.runId,
      'Artifact identity disagreement',
    );
  }
  invariant(execution, 'Missing execution');
  return execution;
}
export function evaluateDomain(
  plan: Plan,
  domain: Domain,
  view: Pick<RunView, 'jobs' | 'attempts' | 'receipts'>,
): DomainResult {
  const entry = plan.domains[domain];
  if (entry.mode === 'unaffected')
    return { status: 'unaffected', executions: [], errors: [] };
  const executions: Origin[] = [];
  const errors: string[] = [];
  for (const item of entry.required) {
    try {
      executions.push(evaluateExecution(plan, item, view));
    } catch (error) {
      errors.push(
        jobName(item.job, item.tuple, item.shard) +
          ':' +
          item.step +
          ': ' +
          message(error),
      );
    }
  }
  return {
    status: errors.length > 0 ? 'failure' : 'success',
    executions,
    errors,
  };
}
export function audit(
  planValue: unknown,
  view: Pick<RunView, 'jobs' | 'attempts' | 'receipts'>,
  viewAttempt: number,
): Receipt {
  const plan = admitPlan(planValue);
  const results = Object.fromEntries(
    domains.map((domain) => [domain, evaluateDomain(plan, domain, view)]),
  ) as Record<Domain, DomainResult>;
  const errors = Object.values(results).flatMap((result) => result.errors);
  // Domain evidence is independent; the required check also covers support Jobs
  // and failures after a successful validation Step (for example artifact upload).
  for (const item of plannedExecutions(plan)) {
    try {
      evaluateExecution(plan, item, view);
      const job = view.jobs.find(
        (candidate) =>
          candidate.name === jobName(item.job, item.tuple, item.shard),
      );
      invariant(
        job?.conclusion === 'success',
        'Required Job did not succeed: ' + job?.name,
      );
    } catch (error) {
      errors.push(message(error));
    }
  }
  if (plan.mode === 'obsolete')
    errors.push('Obsolete main push cannot succeed');
  return {
    schema: 1,
    repository: plan.repository,
    repositoryId: plan.repositoryId,
    workflowId: plan.workflowId,
    runId: plan.runId,
    viewAttempt,
    targetSha: plan.targetSha,
    event: plan.event,
    ref: plan.ref,
    contractHash: plan.contractHash,
    planHash: plan.planHash,
    state:
      plan.mode === 'obsolete'
        ? 'obsolete'
        : errors.length > 0
          ? 'failure'
          : 'candidate',
    jobs: view.receipts,
    domains: results,
    errors,
    createdAt: new Date().toISOString(),
  };
}
export interface ActualResult {
  at: string;
  status: 'success' | 'failure';
  executions: Origin[];
}
/**
Skips do not create events. A copied successful Job retains its original execution time.
*/
export function actualResult(
  view: RunView,
  domain: Domain,
): ActualResult | undefined {
  const entry = view.plan.domains[domain];
  const isPartialCore = entry.mode === 'unaffected' && domain === 'core';
  const required =
    entry.mode === 'run'
      ? entry.required
      : isPartialCore
        ? plannedExecutions(view.plan).filter(
            (item) => item.step === 'native_build',
          )
        : [];
  const actual = required.flatMap((item) =>
    view.jobs
      .filter((job) => job.name === jobName(item.job, item.tuple, item.shard))
      .flatMap((job) =>
        job.steps.filter(
          (step) =>
            step.name === stepName(item.step) &&
            step.conclusion !== 'skipped' &&
            step.started_at &&
            step.status !== 'queued',
        ),
      ),
  );
  if (actual.length === 0) return undefined;
  const completed = required.flatMap((item) =>
    view.jobs
      .filter((job) => job.name === jobName(item.job, item.tuple, item.shard))
      .flatMap((job) =>
        job.steps.filter(
          (step) =>
            [...item.prerequisites, item.step].some(
              (key) => step.name === stepName(key),
            ) &&
            step.conclusion !== 'skipped' &&
            step.started_at &&
            step.status !== 'queued',
        ),
      ),
  );
  invariant(
    completed.every((step) => step.status === 'completed' && step.completed_at),
    'Domain execution is still in progress',
  );
  // An untraceable execution is not an ordinary test failure. The resolver must
  // abandon incremental scheduling instead of manufacturing a failure event.
  for (const item of required) {
    const candidates = view.jobs.filter(
      (job) => job.name === jobName(item.job, item.tuple, item.shard),
    );
    for (const job of candidates) {
      if (
        job.steps.every(
          (step) =>
            !(step.name === stepName(item.step) && step.started_at) ||
            step.conclusion === 'skipped',
        )
      )
        continue;
      const origin = executionOrigin(job, view.attempts);
      jobReceipt(view.plan, item, origin.attempt, view.receipts);
    }
  }
  let result: DomainResult;
  if (isPartialCore) {
    try {
      for (const item of required) evaluateExecution(view.plan, item, view);
      return undefined; // Successful support builds are not a complete Core validation.
    } catch (error) {
      result = { status: 'failure', executions: [], errors: [message(error)] };
    }
  } else result = evaluateDomain(view.plan, domain, view);
  // Cancellation supplies no new positive evidence, but a completed successful
  // domain must not be relabelled as a failure of that domain.
  if (
    result.status === 'success' &&
    (view.run.conclusion === 'cancelled' || view.plan.mode === 'obsolete')
  )
    return undefined;
  const status =
    result.status === 'success' &&
    view.run.status === 'completed' &&
    view.run.conclusion !== 'cancelled' &&
    view.plan.mode !== 'obsolete'
      ? 'success'
      : 'failure';
  return {
    at: completed
      .map((step) => step.completed_at!)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1)!,
    status,
    executions: result.executions,
  };
}
export function latestActual(
  results: ActualResult[],
): ActualResult | undefined {
  invariant(
    results.every((result) => Number.isFinite(Date.parse(result.at))),
    'Invalid execution timestamp',
  );
  const sorted = [...results].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );
  if (
    sorted.length > 1 &&
    Date.parse(sorted[0]!.at) === Date.parse(sorted[1]!.at)
  )
    invariant(
      hashObject(sorted[0]) === hashObject(sorted[1]),
      'Ambiguous concurrent domain results',
    );
  return sorted[0];
}
