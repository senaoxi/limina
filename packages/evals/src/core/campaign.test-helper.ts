import { createCampaign } from './campaign.ts';
import { freezeTaskIdentity, taskCatalog } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { createModelProfile } from './model-profile.ts';
import { type BankRevision, createTaskBank } from './task-bank.ts';
import type { TaskSpec } from './task.ts';

export function campaignFixture(revision: BankRevision = 'v2') {
  const fixed = contentIdentity('synthetic offline tools');
  const tasks: TaskSpec[] = taskCatalog.map((t) => ({
    ...t,
    version: 2,
    ...(revision !== 'v1' && { bankRevision: revision }),
    prompt: `Repair ${t.id} without changing protected inputs.`,
    fixtureDigest: contentIdentity({ fixture: t.id }),
    capturePolicy: { excludedRoots: [], requiredRoots: [] },
    mutationPolicy: { rules: [], protectedRoots: [] },
    dependencyPolicy: {
      inputs: [],
      variants: [
        {
          id: 'fixed',
          inputsDigest: contentIdentity([]),
          closureDigest: fixed,
        },
      ],
    },
    installPlan: {
      toolchainDigest: fixed,
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: contentIdentity({ grader: t.id }),
      requiredAssertions: ['semantic'],
    },
  }));
  const profiles = ['model-one', 'model-two', 'model-three'].map(
    (canonicalModelId) =>
      createModelProfile({
        canonicalModelId,
        displayName: canonicalModelId,
        providerId: 'openai',
        reasoningEffort: 'high',
        requestedServiceTier: 'default',
        supportedEfforts: ['high'],
        capabilitiesDigest: contentIdentity(canonicalModelId),
        instructionDigest: fixed,
        execution: {
          contextWindow: 272_000,
          autoCompactTokenLimit: 245_000,
          toolOutputLimit: 10_000,
        },
        codex: { version: '0.166.0', sha256: fixed, codeModeHostSha256: fixed },
      }),
  );
  const bank = createTaskBank(
    revision,
    tasks.map((task) => ({
      task,
      identity: freezeTaskIdentity(task, fixed, fixed),
    })),
  );
  const campaign = createCampaign({
    seed: 'independent-offline-campaign',
    bank,
    suiteAdmissionId: fixed,
    budgetAnchorId: fixed,
    profiles,
    common: {
      preparedInputsDigest: fixed,
      runnerDigest: fixed,
      toolchainDigest: fixed,
      contextDigest: fixed,
      imageDigest: fixed,
    },
    skillDigest: fixed,
    comparability: 'strict',
  });
  return { campaign, profiles, tasks, fixed };
}
