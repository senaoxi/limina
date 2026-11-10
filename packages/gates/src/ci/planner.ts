import { classification, classificationBudget } from './classification.ts';
import {
  domains,
  files,
  fullPlan,
  matrices,
  requiredNative,
  seal,
} from './contract.ts';
import { assertHead, contractHash, diff, git, prBase } from './git.ts';
import { GitHub } from './github.ts';
import { History } from './history.ts';
import {
  invariant,
  message,
  outputs,
  positiveInteger,
  readJson,
  requiredEnvironment,
  sha,
  writeJson,
} from './io.ts';
import type {
  Checkpoint,
  Domain,
  Identity,
  Plan,
  UnaffectedProof,
} from './types.ts';

interface Preparation {
  plan: Plan;
  slots: { sha: string; paths: string[]; diffDigest: string }[];
  checkpoints?: Record<Domain, Checkpoint>;
  mustRun: Domain[];
}
export function identity(): Identity {
  const event = requiredEnvironment('GITHUB_EVENT_NAME');
  const reference = requiredEnvironment('GITHUB_REF');
  const targetSha = sha(requiredEnvironment('GITHUB_SHA'));
  assertHead(targetSha);
  const value: Identity = {
    repository: requiredEnvironment('GITHUB_REPOSITORY'),
    repositoryId: positiveInteger(
      requiredEnvironment('GITHUB_REPOSITORY_ID'),
      'repository ID',
    ),
    workflowId: 0,
    runId: positiveInteger(requiredEnvironment('GITHUB_RUN_ID'), 'Run ID'),
    originAttempt: positiveInteger(
      requiredEnvironment('GITHUB_RUN_ATTEMPT'),
      'attempt',
    ),
    event,
    ref: reference,
    targetSha,
    ancestryTrusted: false,
    forced: false,
  };
  invariant(
    requiredEnvironment('GITHUB_WORKFLOW_REF').startsWith(
      value.repository + '/.github/workflows/ci.yml@',
    ),
    'Unexpected Workflow path',
  );
  invariant(
    ['push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(event),
    'Unsupported CI event',
  );
  if (event === 'push') {
    invariant(reference === 'refs/heads/main', 'Unexpected push branch');
    value.ancestryTrusted = true;
  } else if (event === 'pull_request') {
    const payload = readJson<{
      action: string;
      pull_request: {
        head: { sha: string };
        base: { sha: string; ref: string; repo: { full_name: string } };
      };
    }>(requiredEnvironment('GITHUB_EVENT_PATH'));
    invariant(
      ['opened', 'synchronize', 'reopened'].includes(payload.action) &&
        payload.pull_request.base.repo.full_name === value.repository &&
        payload.pull_request.base.ref === 'main',
      'Unsupported PR identity',
    );
    value.prHeadSha = sha(payload.pull_request.head.sha);
    value.baseHistorySha = prBase(
      targetSha,
      value.prHeadSha,
      payload.pull_request.base.sha,
    );
    value.ancestryTrusted = Boolean(value.baseHistorySha);
  }
  value.forced =
    value.originAttempt > 1 ||
    event === 'schedule' ||
    event === 'workflow_dispatch' ||
    (event === 'push' &&
      // Match the workflow's case-insensitive startsWith without trimming the subject.
      git(['show', '-s', '--format=%B', targetSha])
        .toString('utf8')
        .toLowerCase()
        .startsWith('release:'));
  return value;
}
export async function prepare(): Promise<void> {
  const id = identity();
  const rolling = requiredEnvironment('ROLLING_NODE').replace(/^v/, '');
  let plan = fullPlan(
    id,
    contractHash(id.targetSha, rolling),
    rolling,
    'Full validation',
  );
  const preparation: Preparation = { plan, slots: [], mustRun: [] };
  try {
    const api = new GitHub();
    const run = await api.run(id.runId);
    invariant(
      run.repository.id === id.repositoryId &&
        run.path === '.github/workflows/ci.yml' &&
        run.run_attempt === id.originAttempt,
      'Current Run identity mismatch',
    );
    plan.workflowId = run.workflow_id;
    if (id.event === 'push' && !id.forced) {
      const current = await api.get<{ object: { sha: string } }>(
        '/git/ref/heads/main',
      );
      if (current.object.sha !== id.targetSha) {
        plan.mode = 'obsolete';
        plan.reason = 'Superseded main push';
      }
    }
    if (
      plan.mode !== 'obsolete' &&
      !id.forced &&
      id.ancestryTrusted &&
      process.env.AFFECTED_CI !== 'disabled'
    ) {
      const resolved = await new History(api, plan).resolve();
      preparation.checkpoints = resolved.checkpoints;
      preparation.mustRun = [...resolved.mustRun];
      for (const checkpoint of Object.values(resolved.checkpoints)) {
        if (
          preparation.slots.some(
            (slot) => slot.sha === checkpoint.successfulSha,
          )
        )
          continue;
        preparation.slots.push({
          sha: checkpoint.successfulSha,
          ...diff(checkpoint.successfulSha, id.targetSha),
        });
      }
      classificationBudget(preparation.slots);
      plan.reason = 'Classification pending';
    } else if (plan.mode !== 'obsolete')
      plan.reason = id.forced
        ? 'Forced full validation'
        : id.ancestryTrusted
          ? 'Incremental scheduling disabled'
          : 'Untrusted baseline identity';
  } catch (error) {
    plan = { ...plan, mode: 'full', reason: message(error) };
    preparation.slots = [];
    delete preparation.checkpoints;
  }
  plan.diffs = preparation.slots.map((slot) => ({
    baseSha: slot.sha,
    paths: slot.paths,
    diffDigest: slot.diffDigest,
  }));
  preparation.plan = seal(plan);
  writeJson(files.preparation, preparation);
  const values: Record<string, string> = { target_sha: id.targetSha };
  for (let index = 0; index < domains.length; index++) {
    values['filter_' + index] = String(index < preparation.slots.length);
    values['base_' + index] = preparation.slots[index]?.sha || id.targetSha;
  }
  outputs(values);
}
export function finalize(): void {
  const prep = readJson<Preparation>(files.preparation);
  let plan = prep.plan;
  assertHead(plan.targetSha);
  try {
    if (prep.checkpoints && plan.mode !== 'obsolete') {
      const classified = prep.slots.map((slot, index) => {
        invariant(
          process.env['FILTER_OUTCOME_' + index] === 'success',
          'Filter failed',
        );
        return classification(
          slot.paths,
          JSON.parse(requiredEnvironment('FILTER_' + index)),
        );
      });
      for (const [index, value] of classified.entries()) {
        invariant(plan.diffs?.[index], 'Missing audit diff');
        plan.diffs[index].filters = value.filters;
      }
      const proposal = Object.fromEntries(
        domains.map((domain) => [domain, true]),
      ) as Record<Domain, boolean>;
      invariant(
        classified.every((value) => value.filters.full_control!.length === 0),
        'Control-plane change requires full CI',
      );
      plan.analysis = {};
      for (const domain of domains) {
        const checkpoint = prep.checkpoints[domain];
        const index = prep.slots.findIndex(
          (slot) => slot.sha === checkpoint.successfulSha,
        );
        invariant(index !== -1, 'Missing domain diff');
        const slot = prep.slots[index]!;
        const value = classified[index]!;
        proposal[domain] =
          domain === 'repository_gates' ||
          prep.mustRun.includes(domain) ||
          value.affected.includes(domain);
        const proof: UnaffectedProof = {
          checkpoint,
          diffDigest: slot.diffDigest,
          paths: slot.paths,
          filters: value.filters,
          classificationDigest: value.classificationDigest,
        };
        plan.analysis[domain] = {
          ...proof,
          mustRun: prep.mustRun.includes(domain),
        };
        if (proposal[domain] || process.env.AFFECTED_CI !== 'enabled') continue;
        plan.domains[domain] = { mode: 'unaffected', proof };
      }
      plan.proposal = proposal;
      plan.mode =
        process.env.AFFECTED_CI === 'enabled' ? 'incremental' : 'full';
      plan.reason =
        plan.mode === 'full'
          ? 'Shadow plan; all domains execute'
          : 'Verified per-domain impact policy';
    }
  } catch (error) {
    plan = fullPlan(plan, plan.contractHash, plan.rollingNode, message(error));
  }
  plan.nativeTuples = requiredNative(plan);
  plan = seal(plan);
  writeJson(files.plan, plan);
  outputs(matrices(plan));
}
