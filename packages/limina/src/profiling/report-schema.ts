import { z } from 'zod';
import type { AnalysisProfile } from '../application/analysis/observability';

const nonnegativeInteger = z.int().nonnegative();
const optionalInteger = nonnegativeInteger.optional();
const nullableInteger = nonnegativeInteger.nullable();
const label = z.string().regex(/^[\w.:-]+$/u);
const optionalLabel = label.optional();
const labels = z.array(label);
const version = z.string().regex(/^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u);
// Relative paths are useful for joining project observations. External paths
// reach this boundary as opaque aliases from the invocation inventory.
const relativePathPattern = String.raw`^(?!/|[^/]*:|(?:.*/)?\.\.(?:/|$))[^\\\u0000-\u001F\u007F]+$`;
const projectPath = z.string().regex(new RegExp(relativePathPattern, 'u'));
const uuid = z.uuidv4();
const interval = z.tuple([nonnegativeInteger, nonnegativeInteger]);
const scope = z.union([
  z.tuple([z.literal('invocation')]),
  z.tuple([z.enum(['project', 'context', 'graph', 'task']), label]),
]);
const producer = z.union([
  z.object({ work: label }),
  z.object({ external: label }),
]);
const reusable = z.object({ end: z.literal('shared'), producer });
const workBase = z.object({
  id: label,
  op: label,
  scope,
  parent: label.optional(),
  pass: nonnegativeInteger.optional(),
});
const work = z.union([
  workBase.extend({
    end: z.enum(['performed', 'computed', 'restored']),
    time: interval,
  }),
  workBase.extend({
    ...reusable.shape,
    reuse: z.literal('ready'),
    atUs: nonnegativeInteger,
  }),
  workBase.extend({
    ...reusable.shape,
    reuse: z.literal('joined'),
    time: interval,
  }),
  workBase.extend({
    end: z.enum(['failed', 'cancelled', 'superseded']),
    time: interval,
    reason: label,
  }),
  workBase.extend({ end: z.literal('not-run'), reason: label }),
  workBase.extend({ end: z.literal('open'), startUs: nonnegativeInteger }),
]);
const cause = z.union([
  z.object({
    code: label,
    input: z.object({ kind: label, ref: projectPath }).optional(),
  }),
  z.object({ decision: label }),
]);
const causes = z.array(cause).min(1);
const decisionBase = z.object({
  id: label,
  work: label,
  layer: label,
  subject: projectPath.optional(),
  basis: z.array(label).optional(),
});
const decision = z.union([
  decisionBase.extend({
    stage: z.literal('lookup'),
    outcome: z.literal('found'),
  }),
  decisionBase.extend({
    stage: z.literal('lookup'),
    outcome: z.enum(['absent', 'corrupt', 'unavailable']),
    causes,
  }),
  decisionBase.extend({
    stage: z.literal('admission'),
    outcome: z.literal('admitted'),
  }),
  decisionBase.extend({
    stage: z.literal('admission'),
    outcome: z.enum(['rejected', 'bypassed', 'unavailable']),
    causes,
  }),
  decisionBase.extend({
    stage: z.literal('adoption'),
    outcome: z.literal('adopted'),
    origin: z.enum(['prior-disk', 'invocation-memory', 'mixed', 'unknown']),
  }),
  decisionBase.extend({
    stage: z.literal('adoption'),
    outcome: z.literal('not-adopted'),
    causes,
  }),
  decisionBase.extend({
    stage: z.literal('publication'),
    outcome: z.literal('published'),
  }),
  decisionBase.extend({
    stage: z.literal('publication'),
    outcome: z.enum(['not-published', 'failed', 'unavailable']),
    causes,
  }),
]);
const metric = z.object({
  key: label,
  scope,
  kind: z.enum(['counter', 'gauge', 'distinct']),
  unit: z.enum(['calls', 'items', 'bytes', 'us']),
  value: nonnegativeInteger,
});
const milestone = z.object({
  gate: z.enum(['core', 'preflight']),
  atUs: nonnegativeInteger,
});
const requestGate = z.enum(['core', 'preflight', 'applied', 'receipt']);
const mode = z.enum([
  'warm',
  'cold',
  'incremental',
  'mixed',
  'not-applicable',
  'unavailable',
]);
const graph = z.object({
  id: label,
  request: label.optional(),
  requestAtUs: nonnegativeInteger.optional(),
  requestGate: requestGate.optional(),
  deliveredAtUs: nonnegativeInteger.optional(),
  projects: z.array(label).optional(),
  purpose: label.optional(),
  providerRun: label.optional(),
  producer: label.optional(),
  attempt: nonnegativeInteger.optional(),
  result: label.optional(),
  source: label.optional(),
  plan: label.optional(),
  prepared: z.array(milestone).optional(),
  applied: z
    .object({ work: label, plan: label, atUs: nonnegativeInteger })
    .optional(),
  receipt: z
    .object({ id: label, slot: label, view: label, atUs: nonnegativeInteger })
    .optional(),
});
const programCounts = z.object({
  op: label,
  attempts: nonnegativeInteger,
  created: nonnegativeInteger,
  failed: nonnegativeInteger,
  pending: nonnegativeInteger,
  passes: z.array(nonnegativeInteger),
});
const rowValues = z.object({
  state: z.enum([
    'failed',
    'partial',
    'rebuilt',
    'restored',
    'covered-by-graph',
    'skipped',
    'unavailable',
  ]),
  workUnionUs: nullableInteger,
  observedWorkUnionUs: nonnegativeInteger,
  sharedWaitUs: nullableInteger,
  failedAttempts: nonnegativeInteger,
  programs: z.array(programCounts),
  metrics: z.array(metric),
});
const graphMode = z.object({
  graph: label,
  purpose: optionalLabel,
  providerRun: optionalLabel,
  mode,
  basis: labels,
});
const graphRow = z.object({
  graph: label,
  purpose: optionalLabel,
  requestGate: requestGate.optional(),
  prepared: milestone.nullable(),
  deliveredAtUs: optionalInteger,
  graphPrepareElapsedUs: nullableInteger,
  requestDeliveryUs: nullableInteger,
  referenceAnalysisWorkUnionUs: nullableInteger,
  graphProjectionWorkUnionUs: nullableInteger,
  artifactsApplyElapsedUs: nullableInteger,
  receiptAtUs: nullableInteger,
});
const workTiming = z.object({
  work: label,
  inclusiveUs: nullableInteger,
  exclusiveUs: nullableInteger,
});
const summary = z.object({
  mode,
  basis: labels,
  graphModes: z.array(graphMode),
  firstCompleteGraphPrepared: milestone.nullable(),
  firstCompleteReceiptCommittedUs: nullableInteger,
  projectRows: z.array(rowValues.extend({ project: label })),
  contextRows: z.array(rowValues.extend({ context: label })),
  graphRows: z.array(graphRow),
  workTimings: z.array(workTiming),
});

const invocation = z.object({
  id: uuid,
  command: z.enum([
    'limina check',
    'limina check pipeline',
    'limina graph',
    'limina graph check',
    'limina graph prepare',
    'limina graph export',
    'limina source',
    'limina source check',
  ]),
  result: z.enum(['passed', 'failed']),
  clock: z.literal('main'),
  commandInvocationUs: nonnegativeInteger,
  externalEndToEndUs: z.null(),
  runUs: nullableInteger,
  cachePolicy: label,
  profileOverhead: z.object({
    inlineObservedUnionUs: nonnegativeInteger,
    finalWriteUs: z.null(),
  }),
});
const runtime = z.object({
  node: version,
  platform: label,
  arch: label,
  entry: z.enum(['source', 'distribution']).optional(),
  limina: version.optional(),
  typescript: version.optional(),
  treeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  peakRssBytes: optionalInteger,
  finalRssBytes: optionalInteger,
  rssSamples: optionalInteger,
  rssSampleIntervalMs: optionalInteger,
});
const coverage = z.object({
  projectInventory: z.enum(['complete', 'partial', 'not-started']),
  workDetail: z.enum(['complete', 'partial']).optional(),
  decisionDetail: z.literal('partial'),
  clockDomains: z.array(z.literal('main')),
  detailsOmitted: nonnegativeInteger,
  omittedByKind: z.record(label, nonnegativeInteger),
});
const project = z.object({
  id: label,
  path: projectPath,
  role: optionalLabel,
  entry: z.boolean().optional(),
  executionChecker: optionalLabel,
  seenVia: optionalLabel,
});
const context = z.object({
  id: label,
  project: label,
  providerRun: label,
  checker: label,
  provider: label,
  role: label,
});
const providerRun = z.object({
  id: label,
  view: label,
  analysisGeneration: nonnegativeInteger,
  providerGeneration: nonnegativeInteger,
  reason: label,
});
const task = z.object({
  id: label,
  name: optionalLabel,
  state: optionalLabel,
  queueWaitUs: optionalInteger,
  readyQueueUs: optionalInteger,
  dispatchToRunnerUs: optionalInteger,
  runnerUs: optionalInteger,
});
const link = z.object({
  kind: z.enum(['uses-result', 'waits-for', 'retry-of', 'supersedes']),
  from: label,
  to: label,
});
const analysisProfileSchema = z.object({
  schemaVersion: z.literal(2),
  metricRevision: z.literal([2, 3]),
  invocation,
  runtime,
  coverage,
  projects: z.array(project),
  contexts: z.array(context),
  providerRuns: z.array(providerRun),
  graphs: z.array(graph),
  tasks: z.array(task),
  work: z.array(work),
  links: z.array(link),
  decisions: z.array(decision),
  metrics: z.array(metric),
  summary,
  gaps: z.array(z.object({ code: label })),
});

export function analysisProfileJsonSchema(): object {
  return z.toJSONSchema(analysisProfileSchema, { reused: 'ref' });
}

export function encodeAnalysisProfile(profile: AnalysisProfile): string {
  // The schema projects the public fields before writing.
  return `${JSON.stringify(analysisProfileSchema.parse(profile))}\n`;
}
