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
  'configDependencies',
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
  context: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(context, ['source'], 'source config must be an object.');
    return;
  }
  addUnknownFieldIssues({
    allowed: sourceConfigKeys,
    ctx: context,
    message: 'unknown source config field.',
    path: ['source'],
    value,
  });
  validateSourceImportAuthorityConfig(value.importAuthority, context);
  validateSourceDeclarationsConfig(value.declarations, context);
  validateSourceKnipConfig(value.knip, context);
}

export const liminaConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({
    config: sharedLiminaConfigShapeSchema.optional(),
    configDependencies: z
      .array(
        z
          .string()
          .refine(
            (value) =>
              value.trim().length > 0 &&
              !/[\0*?[\]{}]/u.test(value) &&
              !/^[a-z][a-z\d+.-]+:/iu.test(value),
            'configDependencies must contain exact file paths, without globs or URLs.',
          ),
      )
      .optional(),
    execution: executionConfigShapeSchema.optional(),
    regions: z.unknown().optional(),
    release: releaseConfigShapeSchema.optional(),
  })
  .superRefine((config, context) => {
    addUnknownFieldIssues({
      allowed: liminaConfigKeys,
      ctx: context,
      message: 'unknown Limina config field.',
      path: [],
      value: config,
    });
    validateRegionsConfig(config.regions, context);
    validateSourceConfig(config.source, context);
  });
