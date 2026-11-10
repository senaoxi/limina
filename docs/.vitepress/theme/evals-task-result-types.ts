import type {
  PublicCampaign,
  PublishedMeasurements,
} from './evals-campaign-types';

export interface PublicTaskResult {
  schemaVersion: 1 | 2 | 3;
  stage?: 'development' | 'sealed';
  kind: 'task-evaluation';
  scope: 'task-condition';
  includedInFormalScores: false;
  complete: true;
  identity: string;
  bankId: string;
  bankRevision: string;
  campaignId: string;
  experimentIdentity: string;
  reportIdentity: string;
  sourceIndexSha256: string;
  taskId: string;
  fixtureIdentity: string;
  gradingIdentity: string;
  executionIdentity: string;
  condition: string;
  profile: PublicCampaign['models'][number]['profile'];
  counts: {
    passed: number;
    valid: number;
    planned: number;
    executions: number;
  };
  measurements: PublishedMeasurements;
  repetitions: { repetition: number; status: string }[];
}
