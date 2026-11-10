import { createHash } from 'node:crypto';

// Wire verification at the docs boundary stays independent of private Evals modules.
// The V1 protocol hashes plain JSON with UTF-8 byte-sorted object keys.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Identity requires plain JSON data');
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).toSorted((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export function contentIdentity(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
interface CostRow {
  observedUsd: number;
  totalUsd: number | null;
  pricedRequests: number;
  unpricedRequests: number;
  complete: boolean;
}
export interface LegacyCostReport {
  version: 1;
  kind: 'api-equivalent-estimate';
  identity: string;
  pricing: {
    version: string;
    currency: 'USD';
    observedOn: string;
    source: string;
  };
  pricingIdentity: string;
  calculationIdentity: string;
  sources: {
    experimentIdentity: string;
    manifestSha256: string;
    journalSha256: string;
  }[];
  attempts: (CostRow & {
    runId: string;
    experimentIdentity: string;
    taskId: string;
    condition: string;
    repetition: number;
    traceSha256: string | null;
    reason: string | null;
  })[];
  summary: ReturnType<typeof summarizeCosts>;
}
/**
Aggregate reported estimates without assigning prices or inventing missing charges.
*/
export function summarizeCosts(rows: CostRow[]) {
  let observedUsd = 0;
  let completeAttempts = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  for (const row of rows) {
    observedUsd += row.observedUsd;
    completeAttempts += Number(row.complete);
    pricedRequests += row.pricedRequests;
    unpricedRequests += row.unpricedRequests;
  }
  return {
    observedUsd,
    totalUsd:
      rows.length > 0 && completeAttempts === rows.length ? observedUsd : null,
    attempts: rows.length,
    completeAttempts,
    pricedRequests,
    unpricedRequests,
  };
}

// The docs workspace consumes JSON through its own independent view contract.
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
