export type CalibrationStatus = 'passed' | 'failed' | 'ambiguous' | 'blocked';

export interface PublicBankCalibration {
  schemaVersion: 1;
  kind: 'task-bank-calibration';
  identity: string;
  bankId: string;
  bankRevision: string;
  completedAt: string;
  scope: 'task-calibration';
  modelPerformanceIncluded: false;
  calculationIdentity: string;
  sources: {
    indexSha256: string;
    bankSha256: string;
    reviewSha256: string;
    calibrationSha256: string;
  };
  inventory: {
    tasks: number;
    development: number;
    sealed: number;
    domains: number;
    negativeControls: number;
  };
  graderCalibration: {
    cases: number;
    matched: number;
    correct: number;
    incorrect: number;
    unsafe: number;
  };
  independentReview: {
    status: CalibrationStatus;
    reviewers: number;
    passed: number;
    adversarialChecks: number;
    referenceAccess: false;
    graderAccess: false;
    inputEquivalenceAuditors: number;
    equivalentInputs: number;
    taskExecutionRepeated: boolean;
  };
  tasks: {
    id: string;
    domain: string;
    split: 'dev' | 'sealed';
    role: 'main' | 'negative-control';
    calibrationCases: number;
    calibrationMatched: number;
    reviewStatus: CalibrationStatus;
    submissionStatus: string;
    adversarialChecks: number;
  }[];
}
