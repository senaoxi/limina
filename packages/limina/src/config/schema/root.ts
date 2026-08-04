import { z } from 'zod';
import { sharedLiminaConfigShapeSchema } from './checkers';
import { validateRegionsConfig } from './regions';
import {
  executionConfigShapeSchema,
  releaseConfigShapeSchema,
} from './release-execution';
import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isPlainConfigRecord,
} from './shared';
import { validateSourceImportAuthorityConfig } from './source-authority';
import { validateSourceDeclarationsConfig } from './source-declarations';
import { validateSourceKnipConfig } from './source-knip';

const liminaConfigKeys = new Set([
  'config',
  'execution',
  'graph',
  'package',
  'pipelines',
  'proof',
  'release',
  'regions',
  'source',
]);
const sourceConfigKeys = new Set(['declarations', 'importAuthority', 'knip']);

function validateSourceConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(ctx, ['source'], 'source config must be an object.');
    return;
  }
  addUnknownFieldIssues({
    allowed: sourceConfigKeys,
    ctx,
    message: 'unknown source config field.',
    path: ['source'],
    value,
  });
  validateSourceImportAuthorityConfig(value.importAuthority, ctx);
  validateSourceDeclarationsConfig(value.declarations, ctx);
  validateSourceKnipConfig(value.knip, ctx);
}

export const liminaConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({
    config: sharedLiminaConfigShapeSchema.optional(),
    execution: executionConfigShapeSchema.optional(),
    regions: z.unknown().optional(),
    release: releaseConfigShapeSchema.optional(),
  })
  .superRefine((config, ctx) => {
    addUnknownFieldIssues({
      allowed: liminaConfigKeys,
      ctx,
      message: 'unknown Limina config field.',
      path: [],
      value: config,
    });
    validateRegionsConfig(config.regions, ctx);
    validateSourceConfig(config.source, ctx);
  });
