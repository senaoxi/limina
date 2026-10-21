import { z } from 'zod';
import type { AnalysisOutcome } from './analysis-outcome';

const texts = z.array(z.string());

const coreWork = z.object({
  id: z.string(),
  configPath: z.string(),
  phase: z.enum(['baseline', 'selection', 'locked']),
  family: z.string(),
  eligibility: z.enum(['eligible', 'unavailable']),
  execution: z.enum(['not-run', 'completed', 'failed']),
  reason: z.string().optional(),
});

export const analysisOutcomeSchema: z.ZodType<AnalysisOutcome> = z.object({
  core: z.object({
    dispatch: z.enum(['completed', 'incomplete']),
    executionFailureIds: texts,
    entries: z.array(coreWork),
  }),
  graphTransaction: z.object({
    state: z.enum(['not-requested', 'blocked', 'completed', 'failed']),
    failures: texts,
  }),
  execution: z.enum(['completed', 'partial', 'failed']),
  traversal: z.enum(['complete-within-boundary', 'incomplete']),
  compilationRelations: z.enum(['determined', 'undetermined']),
  governance: z.object({
    scope: z.literal('generated-graph'),
    state: z.enum(['compliant', 'violations', 'unavailable']),
    diagnostics: texts,
  }),
  buildAdmission: z.object({
    scope: z.literal('generated-graph-materialization'),
    state: z.enum(['admitted', 'denied', 'unavailable']),
    reasons: texts,
  }),
});
