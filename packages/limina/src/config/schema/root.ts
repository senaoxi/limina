import { z } from 'zod';
import { scopeConfigShapeSchema } from './checkers';
import { validateGraphConfig, validateProofConfig } from './graph-proof';
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
  'scope',
  'graph',
  'source',
  'proof',
  'package',
  'release',
  'pipelines',
  'concurrency',
  'cache',
]);
const sourceConfigKeys = new Set(['declarations', 'importAuthority', 'knip']);
const cacheConfigKeys = new Set<PropertyKey>(['dependencies']);

const cacheOptionsShapeSchema = z.looseObject({
  dependencies: z.array(
    z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          !/[\0*?[\]{}]/u.test(value) &&
          !/^[a-z][a-z\d+.-]+:/iu.test(value),
        'cache.dependencies must contain exact file paths, without globs or URLs.',
      ),
  ),
});

function validateCacheFields(
  value: object,
  context: ConfigValidationContext,
): void {
  // Validate original keys; Zod object copies omit hidden and symbol fields.
  for (const key of Reflect.ownKeys(value)) {
    if (cacheConfigKeys.has(key)) continue;
    addConfigIssue(context, [String(key)], 'unknown cache config field.');
  }
}

function validateCacheOptions(
  value: unknown,
  context: ConfigValidationContext,
): void {
  const result = cacheOptionsShapeSchema.safeParse(value);
  if (result.success) {
    validateCacheFields(value as object, context);
    return;
  }
  for (const issue of result.error.issues)
    addConfigIssue(context, issue.path, issue.message);
}

const cacheConfigShapeSchema = z.unknown().superRefine((value, context) => {
  if (typeof value === 'boolean') return;
  validateCacheOptions(value, context);
});

function validateSourceConfig(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(context, ['source'], 'source config must be an object.');
    return;
  }
  validateSourceFields(value, context);
}

function validateSourceFields(
  value: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  addUnknownFieldIssues({
    allowed: sourceConfigKeys,
    ctx: context,
    message: 'unknown source config field.',
    path: ['source'],
    value,
  });
  if (Object.keys(value).every((key) => !sourceConfigKeys.has(key)))
    addConfigIssue(
      context,
      ['source'],
      'source config must declare knip, declarations, or importAuthority.',
    );
  validateSourceImportAuthorityConfig(value.importAuthority, context);
  validateSourceDeclarationsConfig(value.declarations, context);
  validateSourceKnipConfig(value.knip, context);
}

export const liminaConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({
    // A rejecting field catches non-enumerable legacy declarations too.
    configDependencies: z.never().optional(),
    scope: scopeConfigShapeSchema.optional(),
    graph: z.unknown().optional(),
    source: z.unknown().optional(),
    proof: z.unknown().optional(),
    release: releaseConfigShapeSchema.optional(),
    cache: cacheConfigShapeSchema.optional(),
    concurrency: executionConfigShapeSchema.optional(),
  })
  .superRefine((config, context) => {
    addUnknownFieldIssues({
      allowed: liminaConfigKeys,
      ctx: context,
      message: 'unknown Limina config field.',
      path: [],
      value: config,
    });
    if (Object.hasOwn(config, 'graph'))
      validateGraphConfig(config.graph, context);
    validateSourceConfig(config.source, context);
    if (Object.hasOwn(config, 'proof'))
      validateProofConfig(config.proof, context);
  });
