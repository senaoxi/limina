export type Domain =
  | 'repository_gates'
  | 'core'
  | 'limina_unit'
  | 'migrate_unit'
  | 'tooling'
  | 'integration'
  | 'smoke'
  | 'windows'
  | 'checker_compatibility'
  | 'docs';

export interface Tuple {
  key: string;
  os: string;
  node: string;
  platform: 'linux' | 'darwin' | 'win32';
}
export interface Execution {
  job: string;
  tuple: string;
  shard: string;
  step: string;
  prerequisites: string[];
  artifact: 'native' | 'bootstrap' | null;
}
export interface Origin {
  jobKey: string;
  tuple: string;
  shard: string;
  stepKey: string;
  originAttempt: number;
  originJobId: number;
  startedAt: string;
  completedAt: string;
  outcome: string;
}
export interface Checkpoint {
  domain: Domain;
  successfulSha: string;
  runId: number;
  viewAttempt: number;
  contractHash: string;
  planHash: string;
  executions: Origin[];
  completedAt: string;
}
export interface UnaffectedProof {
  checkpoint: Checkpoint;
  diffDigest: string;
  classificationDigest: string;
  paths: string[];
  filters: Record<string, string[]>;
}
export type DomainPlan =
  | { mode: 'run'; required: Execution[] }
  | { mode: 'unaffected'; proof: UnaffectedProof };
export interface Identity {
  repository: string;
  repositoryId: number;
  workflowId: number;
  runId: number;
  originAttempt: number;
  event: string;
  ref: string;
  targetSha: string;
  prHeadSha?: string;
  baseHistorySha?: string;
  ancestryTrusted: boolean;
  forced: boolean;
}
export interface Plan extends Identity {
  schema: 1;
  contractHash: string;
  planHash: string;
  rollingNode: string;
  createdAt: string;
  mode: 'full' | 'incremental' | 'obsolete';
  reason: string;
  domains: Record<Domain, DomainPlan>;
  nativeTuples: Tuple[];
  proposal?: Record<Domain, boolean>;
  diffs?: {
    baseSha: string;
    paths: string[];
    diffDigest: string;
    filters?: Record<string, string[]>;
  }[];
  analysis?: Partial<Record<Domain, UnaffectedProof & { mustRun: boolean }>>;
}
export interface ApiStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}
export interface ApiJob {
  id: number;
  run_id: number;
  run_attempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  steps: ApiStep[];
}
export interface ApiRun {
  id: number;
  workflow_id: number;
  path: string;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  repository: { id: number; full_name: string };
}
export interface ApiArtifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; head_sha: string };
}
export interface StepState {
  outcome: string;
  conclusion: string;
  outputs?: Record<string, string>;
}
export interface ArtifactManifest {
  schema: 1;
  kind: 'bootstrap' | 'native';
  repository: string;
  runId: number;
  producerAttempt: number;
  producerJob: string;
  targetSha: string;
  planHash: string;
  contractHash: string;
  tuple: string;
  os: string;
  arch: string;
  node: string;
  pnpm: string;
  lockHash: string;
  files: { path: string; hash: string; mode: number }[];
  digest: string;
}
export interface JobReceipt {
  schema: 1;
  repository: string;
  runId: number;
  executionAttempt: number;
  job: string;
  tuple: string;
  shard: string;
  targetSha: string;
  planHash: string;
  contractHash: string;
  steps: Record<string, StepState>;
  artifacts: ArtifactManifest[];
  createdAt: string;
}
export interface DomainResult {
  status: 'success' | 'failure' | 'unaffected';
  executions: Origin[];
  errors: string[];
}
export interface Receipt {
  schema: 1;
  repository: string;
  repositoryId: number;
  workflowId: number;
  runId: number;
  viewAttempt: number;
  targetSha: string;
  event: string;
  ref: string;
  contractHash: string;
  planHash: string;
  state: 'candidate' | 'failure' | 'obsolete';
  jobs: JobReceipt[];
  domains: Record<Domain, DomainResult>;
  errors: string[];
  createdAt: string;
}
export interface RunView {
  run: ApiRun;
  plan: Plan;
  jobs: ApiJob[];
  attempts: Map<number, ApiJob[]>;
  receipts: JobReceipt[];
  audit: Receipt;
}
