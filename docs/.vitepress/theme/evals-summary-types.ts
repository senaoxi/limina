import type {
  PublicCampaign,
  PublishedMeasurements,
} from './evals-campaign-types';

type Report = NonNullable<PublicCampaign['models'][number]['report']>;
interface Reference {
  file: string;
  sha256: string;
  campaignId: string;
  reportIdentity: string;
  bankId: string;
}
export interface PublicCurrentSummary {
  schemaVersion: 1 | 2 | 3;
  kind: 'current-task-summary';
  policy: 'latest-complete-task-condition';
  identity: string;
  calculationIdentity: string;
  bankRevision: string;
  stage: string;
  modelProfileId: string;
  revision?: {
    kind: 'task-contract-revision';
    from: {
      bankId: string;
      fixtureIdentity: string;
      gradingIdentity: string;
      executionIdentity: string;
    };
    to: NonNullable<PublicCurrentSummary['revision']>['from'];
  };
  sources: {
    base: Reference & { sourceIndexDigest: string };
    task: Reference & {
      identity: string;
      experimentIdentity: string;
      sourceIndexSha256: string;
      taskId: string;
      condition: string;
      fixtureIdentity?: string;
      gradingIdentity?: string;
      executionIdentity?: string;
    };
  };
  selectedExecutions: number;
  sourceExecutions: number;
  supersededExecutions: number;
  counts: NonNullable<Report['counts']>;
  macro: Record<string, number>;
  differencePercentagePoints: number;
  domains: {
    id: string;
    taskCount: number;
    counts: NonNullable<Report['counts']>;
    conditions: Record<string, number>;
    differencePercentagePoints: number;
  }[];
  measurements: {
    main: {
      all: PublishedMeasurements;
      conditions: Record<string, PublishedMeasurements>;
    };
    negativeControls: {
      all: PublishedMeasurements;
      conditions: Record<string, PublishedMeasurements>;
    };
  };
  tasks?: { id: string; measurements: PublishedMeasurements }[];
}
