import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSource } from './artifacts.ts';
import {
  createArtifact,
  restoreArtifact,
  selectArtifact,
} from './artifacts.ts';
import { admitPlan, files, fullPlan, nativeJob, selected } from './contract.ts';
import { assertHead, contractHash } from './git.ts';
import { GitHub } from './github.ts';
import {
  invariant,
  message,
  outputs,
  readJson,
  requiredEnvironment,
  writeJson,
} from './io.ts';
import { finalize, identity, prepare } from './planner.ts';
import { status, validatePublication } from './status.ts';
import type {
  ApiRun,
  ArtifactManifest,
  JobReceipt,
  StepState,
} from './types.ts';

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'load-plan') {
    const expected = process.env.CI_PLAN_HASH;
    const directory = '.reports/ci/plans';
    const matches = existsSync(directory)
      ? readdirSync(directory).flatMap((name) => {
          const file =
            name === 'plan.json'
              ? path.join(directory, name)
              : path.join(directory, name, 'plan.json');
          if (!existsSync(file)) return [];
          const raw = readJson<{ planHash?: unknown }>(file);
          return raw.planHash === expected ? [admitPlan(raw)] : [];
        })
      : [];
    if (matches.length === 1) writeJson(files.plan, matches[0]);
    else {
      invariant(
        !expected && process.env.CI_JOB !== 'status',
        'Frozen Plan unavailable; rerun all jobs',
      );
      const id = identity();
      const rolling = process.env.ROLLING_NODE || '24.15.0';
      writeJson(
        files.plan,
        fullPlan(
          id,
          contractHash(id.targetSha, rolling),
          rolling,
          'Missing remote Plan: execution fallback only',
        ),
      );
    }
    return;
  }
  if (command === 'prepare') {
    await prepare();
    return;
  }
  if (command === 'finalize') {
    finalize();
    return;
  }
  if (command === 'publish') {
    const response = readJson<{ workflow_runs: ApiRun[] }>(arguments_[0]!);
    invariant(response.workflow_runs[0], 'No release CI Run');
    await validatePublication(
      response.workflow_runs[0],
      requiredEnvironment('RELEASE_SHA'),
    );
    return;
  }
  if (command === 'status') {
    await status();
    return;
  }
  const plan = admitPlan(readJson(files.plan));
  const job = requiredEnvironment('CI_JOB');
  const tuple = requiredEnvironment('CI_TUPLE');
  const shard = process.env.CI_SHARD || 'all';
  const attempt = Number(requiredEnvironment('GITHUB_RUN_ATTEMPT'));
  switch (command) {
    case 'admit': {
      assertHead(plan.targetSha);
      invariant(
        plan.mode !== 'obsolete' &&
          plan.runId === Number(requiredEnvironment('GITHUB_RUN_ID')) &&
          plan.repository === requiredEnvironment('GITHUB_REPOSITORY') &&
          plan.targetSha === requiredEnvironment('GITHUB_SHA') &&
          plan.contractHash === contractHash(plan.targetSha, plan.rollingNode),
        'Plan admission failed',
      );
      const steps = selected(plan, job, tuple, shard);
      if (
        plan.nativeTuples.some((item) => item.key === tuple) &&
        job === nativeJob(tuple)
      )
        steps.push('native_build');
      outputs({
        ...Object.fromEntries(steps.map((step) => ['run_' + step, 'true'])),
      });

      break;
    }
    case 'artifact-create': {
      invariant(
        arguments_[0] === 'bootstrap' || arguments_[0] === 'native',
        'Unknown artifact kind',
      );
      createArtifact(plan, arguments_[0], job, tuple, attempt);

      break;
    }
    case 'artifact-select': {
      invariant(
        arguments_[0] === 'bootstrap' || arguments_[0] === 'native',
        'Unknown artifact kind',
      );
      await selectArtifact(
        new GitHub(plan.repository),
        plan,
        arguments_[0],
        tuple,
      );

      break;
    }
    case 'artifact-restore': {
      restoreArtifact(
        plan,
        readJson<ArtifactSource>('.reports/ci/artifact-source.json'),
      );

      break;
    }
    case 'receipt': {
      const artifacts = existsSync('.reports/ci/consumed.json')
        ? readJson<ArtifactManifest[]>('.reports/ci/consumed.json')
        : [];
      const receipt: JobReceipt = {
        schema: 1,
        repository: plan.repository,
        runId: plan.runId,
        executionAttempt: attempt,
        job,
        tuple,
        shard,
        targetSha: plan.targetSha,
        planHash: plan.planHash,
        contractHash: plan.contractHash,
        steps: JSON.parse(requiredEnvironment('CI_STEPS')) as Record<
          string,
          StepState
        >,
        artifacts,
        createdAt: new Date().toISOString(),
      };
      writeJson(files.receipt, receipt);

      break;
    }
    default:
      throw new Error('Unknown CI command: ' + command);
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(message(error) + '\n');
  process.exitCode = 1;
}
