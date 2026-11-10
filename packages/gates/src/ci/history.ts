import { admitPlan, artifactName, domains } from './contract.ts';
import { actualResult, executionOrigin, latestActual } from './evidence.ts';
import { contractHash, gitText, isAncestor } from './git.ts';
import type { GitHub } from './github.ts';
import { oneArtifact } from './github.ts';
import { hashObject, invariant } from './io.ts';
import type {
  ApiJob,
  ApiRun,
  Checkpoint,
  Domain,
  Plan,
  Receipt,
  RunView,
} from './types.ts';

export class History {
  private views = new Map<number, RunView>();
  private contracts = new Map<string, string>();
  readonly api: GitHub;
  readonly plan: Plan;
  constructor(api: GitHub, plan: Plan) {
    this.api = api;
    this.plan = plan;
  }
  eligible(run: ApiRun): boolean {
    return (
      run.repository.id === this.plan.repositoryId &&
      run.repository.full_name === this.plan.repository &&
      run.workflow_id === this.plan.workflowId &&
      run.path === '.github/workflows/ci.yml' &&
      run.event === 'push' &&
      run.head_branch === 'main'
    );
  }
  sameContract(run: ApiRun): boolean {
    if (!this.contracts.has(run.head_sha))
      this.contracts.set(
        run.head_sha,
        contractHash(run.head_sha, this.plan.rollingNode),
      );
    return this.contracts.get(run.head_sha) === this.plan.contractHash;
  }
  async view(run: ApiRun): Promise<RunView> {
    if (this.views.has(run.id)) return this.views.get(run.id)!;
    const attempts = new Map<number, ApiJob[]>();
    for (
      let attempt = Math.max(1, run.run_attempt - 29);
      attempt <= run.run_attempt;
      attempt++
    )
      attempts.set(attempt, await this.api.jobs(run.id, attempt));
    const jobs = attempts.get(run.run_attempt)!;
    const planners = jobs.filter((job) => job.name === 'Plan');
    invariant(
      planners.length === 1 && planners[0]!.conclusion === 'success',
      'No completed frozen plan; rerun all jobs',
    );
    const origin = executionOrigin(planners[0]!, attempts);
    const artifacts = await this.api.artifacts(run.id);
    const planArtifact = oneArtifact(
      artifacts,
      artifactName('plan', origin.attempt),
    );
    const plan = admitPlan(
      await this.api.jsonArtifact<Plan>(planArtifact, 'plan.json'),
    );
    invariant(
      plan.runId === run.id &&
        plan.originAttempt === origin.attempt &&
        plan.repository === run.repository.full_name &&
        plan.repositoryId === run.repository.id &&
        plan.targetSha === run.head_sha &&
        plan.contractHash === this.plan.contractHash &&
        plan.event === 'push' &&
        plan.ref === 'refs/heads/main',
      'Historical plan identity mismatch',
    );
    invariant(
      plan.workflowId === run.workflow_id ||
        (plan.workflowId === 0 && plan.mode === 'full'),
      'Historical Workflow identity mismatch',
    );
    const audit = await this.api.jsonArtifact<Receipt>(
      oneArtifact(artifacts, artifactName('audit', run.run_attempt)),
      'audit.json',
    );
    invariant(
      audit.runId === run.id &&
        audit.viewAttempt === run.run_attempt &&
        audit.planHash === plan.planHash &&
        audit.contractHash === plan.contractHash &&
        audit.targetSha === plan.targetSha &&
        audit.repositoryId === plan.repositoryId,
      'Historical audit identity mismatch',
    );
    const view = { run, plan, jobs, attempts, receipts: audit.jobs, audit };
    this.views.set(run.id, view);
    return view;
  }
  async resolve(): Promise<{
    checkpoints: Record<Domain, Checkpoint>;
    mustRun: Set<Domain>;
  }> {
    this.api.remaining();
    const base = this.plan.baseHistorySha || this.plan.targetSha;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const discovered = (await this.api.runs({ created: '>=' + since })).filter(
      (run) =>
        run.id !== this.plan.runId &&
        this.eligible(run) &&
        isAncestor(run.head_sha, base),
    );
    const candidates = new Set(discovered.map((run) => run.head_sha));
    invariant(candidates.size > 0, 'No candidate validation checkpoints');
    const ancestry = gitText(['rev-list', '--topo-order', base]).split('\n');
    const ordered = ancestry.filter((commit) => candidates.has(commit));
    const checkpoints: Partial<Record<Domain, Checkpoint>> = {};
    const mustRun = new Set<Domain>();
    const relevant = new Set<string>();
    // Close the history from target through the oldest discovered candidate. Every SHA gets an
    // unrestricted query, so a Run created outside the window but recently rerun cannot disappear.
    const oldest = Math.max(
      ...ordered.map((commit) => ancestry.indexOf(commit)),
    );
    invariant(
      oldest >= 0 && oldest < 1000,
      'Ancestral closure exceeds resolver budget',
    );
    const interval = ancestry.slice(0, oldest + 1);
    for (const commit of interval) relevant.add(commit);
    const results = new Map<string, { run: ApiRun; view: RunView }[]>();
    for (const commit of relevant) {
      const runs = (await this.api.runs({ head_sha: commit })).filter(
        (run) => run.id !== this.plan.runId && this.eligible(run),
      );
      const views: { run: ApiRun; view: RunView }[] = [];
      for (const run of runs) {
        if (!this.sameContract(run)) continue;
        // A currently executing matching Run may later invalidate a success. Do not guess.
        invariant(
          run.status === 'completed',
          'Concurrent historical validation is incomplete',
        );
        views.push({ run, view: await this.view(run) });
      }
      results.set(commit, views);
    }
    const findCheckpoint = (domain: Domain): Checkpoint | undefined => {
      for (const commit of interval) {
        const views = results.get(commit) || [];
        const events = views.flatMap(({ run, view }) => {
          const result = actualResult(view, domain);
          return result ? [{ ...result, run, view }] : [];
        });
        const latest = latestActual(events);
        if (!latest) continue;
        if (latest.status === 'failure') {
          mustRun.add(domain);
          continue;
        }
        if (
          Date.parse(latest.at) < Date.parse(since) ||
          Date.parse(latest.at) > Date.now()
        )
          continue;
        const selected = events.filter(
          (entry) =>
            hashObject(entry.executions) === hashObject(latest.executions) &&
            entry.at === latest.at,
        );
        invariant(selected.length === 1, 'Ambiguous checkpoint source');
        const event = selected[0]!;
        return {
          domain,
          successfulSha: commit,
          runId: event.run.id,
          viewAttempt: event.run.run_attempt,
          contractHash: this.plan.contractHash,
          planHash: event.view.plan.planHash,
          executions: latest.executions,
          completedAt: latest.at,
        };
      }
      return undefined;
    };
    for (const domain of domains) {
      checkpoints[domain] = findCheckpoint(domain);
      invariant(checkpoints[domain], 'No valid checkpoint for ' + domain);
    }
    this.api.remaining();
    return { checkpoints: checkpoints as Record<Domain, Checkpoint>, mustRun };
  }
}
