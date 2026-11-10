import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { campaignFixture } from '../core/campaign.test-helper.ts';
import { campaignExperiment } from '../core/campaign.ts';
import { type EvidenceReference, RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import {
  admittedSmokeProfiles,
  readSmokeAdmission,
  validateDecisionRoster,
  writeSmokeCompletion,
} from './campaign-smoke.ts';

test('a failed smoke arm excludes its profile while another complete profile remains admitted', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-smoke-admission-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { campaign, tasks } = campaignFixture();
  const stores = new Map<string, RunStore>();
  const first = campaign.profiles[0]!;
  for (const profile of campaign.profiles) {
    const isUnverified = profile.id === campaign.profiles[2]!.id;
    const store = new RunStore(
      path.join(root, profile.id),
      campaignExperiment(campaign, profile.id, 'smoke'),
    );
    stores.set(profile.id, store);
    for (const slot of store.manifest.slots) {
      const start = store.startNext()!;
      const evidence: EvidenceReference[] = [];
      for (const kind of [
        'fixture',
        'start',
        'final',
        'trace',
        'assertions',
      ] as const) {
        const file = `${start.runId}-${kind}.json`;
        const data = JSON.stringify(
          kind === 'trace'
            ? {
                evidence: {
                  status: isUnverified ? 'partial' : 'complete',
                  modelProfileId: profile.id,
                  observedModelIds: [
                    isUnverified ? 'another-model' : profile.canonicalModelId,
                  ],
                },
              }
            : { syntheticOfflineEvidence: true },
        );
        await writeFile(path.join(store.directory, file), data);
        evidence.push({ kind, path: file, sha256: sha256(data) });
      }
      const task = tasks.find((task) => task.id === slot.taskId)!;
      store.finish(start.runId, task, {
        facts: {
          execution: isUnverified
            ? { status: 'error' }
            : { status: 'completed', exitCode: 0 },
          captureStatus: 'complete',
          traceStatus: isUnverified ? 'partial' : 'complete',
          mutation: {
            status: 'accepted',
            changes: [{ path: 'limina.config.mjs' }],
            dependencyVariant: task.dependencyPolicy.variants[0]!,
          },
          grade: {
            taskId: task.id,
            graderDigest: task.gradingContract.graderDigest,
            status: 'complete',
            assertions: [
              {
                id: 'semantic',
                passed: profile.id === first.id || slot.condition !== 'skill',
              },
            ],
          },
        },
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          credits: null,
          estimatedUsd: null,
          settledUsd: null,
          source: 'synthetic offline measurement',
          complete: true,
          settlement: 'unknown',
        },
        time: { agentMs: 1, endToEndMs: 2 },
        activation: {
          installed: slot.condition === 'base' ? 'no' : 'yes',
          discovered: 'unknown',
          used: 'unknown',
        },
        evidence,
      });
    }
  }
  const unverified = stores.get(campaign.profiles[2]!.id)!.summary();
  assert.ok(
    unverified.attempts.every((a) => a.outcome.status === 'agent_error'),
  );
  assert.ok(unverified.slots.every((s) => s.status === 'unknown'));
  const completion = await writeSmokeCompletion(campaign, root, stores);
  assert.deepEqual([...(await readSmokeAdmission(campaign, root))], [first.id]);
  const roster = {
    models: [{ profileId: first.id }],
    notAdmittedProfileIds: campaign.profiles
      .filter((p) => p.id !== first.id)
      .map((p) => p.id),
  };
  assert.deepEqual(
    validateDecisionRoster(campaign, new Set([first.id]), roster).map(
      (p) => p.id,
    ),
    [first.id],
  );
  assert.throws(
    () =>
      validateDecisionRoster(campaign, new Set([first.id]), {
        models: campaign.profiles.map((p) => ({ profileId: p.id })),
      }),
    /admitted models/,
  );
  const transplanted = structuredClone(completion);
  const firstId = transplanted.runs[0]!.profileId;
  transplanted.runs[0]!.profileId = transplanted.runs[1]!.profileId;
  transplanted.runs[1]!.profileId = firstId;
  assert.throws(
    () => admittedSmokeProfiles(campaign, transplanted),
    /another profile/,
  );
  const source = completion.runs[0]!;
  const journal = path.join(source.directory, 'attempts.jsonl');
  const original = await readFile(journal);
  await writeFile(journal, Buffer.concat([Buffer.from('altered'), original]));
  await assert.rejects(
    readSmokeAdmission(campaign, root),
    /journal prefix changed/,
  );
  assert.equal(
    stores.get(first.id)!.manifest.inputs.modelProfile!.id,
    first.id,
  );
});
