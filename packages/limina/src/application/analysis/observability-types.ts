export type ProfileScope =
  | readonly ['invocation']
  | readonly ['project' | 'context' | 'graph' | 'task', string];

export type Interval = readonly [startUs: number, endUs: number];

export type ProducerReference =
  | { work: string; external?: never }
  | { external: string; work?: never };

export type WorkEnd =
  | {
      end: 'performed' | 'computed' | 'restored';
      time: Interval;
      reuse?: never;
    }
  | {
      end: 'shared';
      producer: ProducerReference;
      reuse: 'ready';
      atUs: number;
      time?: never;
    }
  | {
      end: 'shared';
      producer: ProducerReference;
      reuse: 'joined';
      time: Interval;
      atUs?: never;
    }
  | {
      end: 'failed' | 'cancelled' | 'superseded';
      time: Interval;
      reason: string;
    }
  | { end: 'not-run'; reason: string; time?: never }
  | { end: 'open'; startUs: number; time?: never };

export type WorkRecord = {
  id: string;
  scope: ProfileScope;
  op: string;
  parent?: string;
  pass?: number;
} & WorkEnd;

export type CacheCause =
  | { code: string; input?: { kind: string; ref: string }; decision?: never }
  | { decision: string; code?: never; input?: never };

interface Why {
  causes: readonly [CacheCause, ...CacheCause[]];
  origin?: never;
}
interface Plain {
  causes?: never;
  origin?: never;
}

export type CacheFact = { basis?: readonly string[] } & (
  | ({ stage: 'lookup'; outcome: 'found' } & Plain)
  | ({ stage: 'lookup'; outcome: 'absent' | 'corrupt' | 'unavailable' } & Why)
  | ({ stage: 'admission'; outcome: 'admitted' } & Plain)
  | ({
      stage: 'admission';
      outcome: 'rejected' | 'bypassed' | 'unavailable';
    } & Why)
  | {
      stage: 'adoption';
      outcome: 'adopted';
      origin: 'prior-disk' | 'invocation-memory' | 'mixed' | 'unknown';
      causes?: never;
    }
  | ({ stage: 'adoption'; outcome: 'not-adopted' } & Why)
  | ({ stage: 'publication'; outcome: 'published' } & Plain)
  | ({
      stage: 'publication';
      outcome: 'not-published' | 'failed' | 'unavailable';
    } & Why)
);

export type DecisionRecord = {
  id: string;
  work: string;
  layer: string;
  subject?: string;
} & CacheFact;

export interface GraphFields {
  request?: string;
  requestAtUs?: number;
  requestGate?: 'core' | 'preflight' | 'applied' | 'receipt';
  deliveredAtUs?: number;
  projects?: readonly string[];
  purpose?: string;
  providerRun?: string;
  producer?: string;
  attempt?: number;
  result?: string;
  source?: string;
  plan?: string;
  prepared?: { gate: 'core' | 'preflight'; atUs: number }[];
  applied?: { work: string; plan: string; atUs: number };
  receipt?: { id: string; slot: string; view: string; atUs: number };
}

export interface ProjectRecord {
  id: string;
  path: string;
  role?: string;
  entry?: boolean;
  executionChecker?: string;
  seenVia?: string;
}

export interface ContextRecord {
  id: string;
  project: string;
  providerRun: string;
  checker: string;
  provider: string;
  role: string;
}

export interface MetricRecord {
  key: string;
  scope: ProfileScope;
  kind: 'counter' | 'gauge' | 'distinct';
  unit: 'calls' | 'items' | 'bytes' | 'us';
  value: number;
}
