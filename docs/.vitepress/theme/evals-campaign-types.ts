// The page consumes the public JSON boundary, never private controller modules.
export interface PublishedAverage {
  mean: number | null;
  observedSum: number;
  total: number | null;
  measured: number;
  executions: number;
  coverage: number;
  cells: number;
  measuredCells: number;
}
export interface PublishedMeasurements {
  agentMs: PublishedAverage;
  endToEndMs: PublishedAverage;
  apiEquivalentUsd: PublishedAverage;
  settledUsd: PublishedAverage;
}
interface PublishedCounts {
  passed: number;
  valid: number;
  planned: number;
  executions: number;
}
interface PublishedAttempt {
  id: string;
  ordinal: number;
  status: string;
}
interface PublishedRepetition {
  repetition: number;
  status: string;
  attemptCount: number;
  attempts: PublishedAttempt[];
  activation: {
    installed: string;
    discoverable: string;
    discovered: string;
    skillRead: string;
    referencesRead: number;
    followed: string;
  } | null;
  attribution: {
    primary: string;
    adjudication: string;
    confidence: string;
  } | null;
}
interface PublishedCondition {
  passed: number;
  valid: number;
  planned: number;
  coverage: number;
  bounds: [number, number] | null;
  repetitions: PublishedRepetition[];
  executions?: number;
  measurements?: PublishedMeasurements;
}
interface PublishedTask {
  id: string;
  domain: string;
  role: 'main' | 'negative-control';
  comparison: {
    planned: number;
    valid: number;
    regressed: number;
    liftPercentagePoints: number | null;
    pairs: { repetition: number; base: number | null; skill: number | null }[];
  };
  conditions: Record<string, PublishedCondition>;
}
export interface PublicCampaign {
  campaignId: string;
  reportIdentity: string;
  bankId: string;
  bankRevision: string;
  stage: string;
  comparability: 'strict' | 'native-profile';
  models: {
    status: 'recorded' | 'not_admitted' | 'missing';
    planned: number;
    profile: {
      id: string;
      model: string;
      displayName: string;
      reasoningEffort: string;
      serviceTier: string;
      codexVersion?: string;
    };
    report: {
      executions: number;
      planned: number;
      complete: boolean;
      macro: Record<string, number | null>;
      liftPercentagePoints: number | null;
      counts?: Record<string, PublishedCounts>;
      measurements?: {
        version: 1;
        policy: 'task-condition-equal-all-executions';
        pricing: { identity: string; version: string; observedOn: string };
        main: {
          all: PublishedMeasurements;
          conditions: Record<string, PublishedMeasurements>;
        };
        negativeControls: {
          all: PublishedMeasurements;
          conditions: Record<string, PublishedMeasurements>;
        };
      };
      domains: {
        id: string;
        taskCount?: number;
        counts?: Record<string, PublishedCounts>;
        conditions: Record<string, number | null>;
        liftPercentagePoints: number | null;
      }[];
      tasks: PublishedTask[];
    } | null;
  }[];
}
