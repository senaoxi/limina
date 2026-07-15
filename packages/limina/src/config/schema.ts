import { getCheckerAdapter } from '#checkers';
import type { LiminaConfig } from '#config/runner';
import { formatUnknownValue } from '#utils/values';
import { z } from 'zod';
import { ConfigurationError } from '../domain/validation/errors';

const checkerExtensionsConfigReason =
  'checker extensions are fixed by built-in presets and cannot be configured.';

const checkerRoutesConfigReason =
  'checker routes are not supported; configure checker.include with source tsconfig selectors.';

const unsupportedCheckerPresetReason =
  'configured checkers require a built-in checker adapter.';

const checkerEntryConfigReason =
  'checker.entry has been removed; configure checker.include with source tsconfig selectors.';

const checkerConfigReason =
  'config.checkers must be an object auto config or an object keyed by checker name.';

const checkerAutoStringConfigReason =
  'checkers: "auto" has been removed; omit config.checkers or use { mode: "auto" }.';

const autoCheckerMixedConfigReason =
  'auto checker config must not be mixed with named checker entries.';

const autoCheckerModeConfigReason =
  'auto checker config requires mode: "auto".';

const importAnalysisConfigReason =
  'config.imports must be an object when configured.';

const vueImportParserConfigReason =
  'config.imports.vue must be "heuristic" or "compiler-sfc".';

const checkerConfigShapeSchema = z
  .looseObject({})
  .superRefine((checker, ctx) => {
    const preset = checker.preset;
    const include = checker.include;
    const exclude = checker.exclude;

    if (Object.hasOwn(checker, 'entry')) {
      ctx.addIssue({
        code: 'custom',
        message: checkerEntryConfigReason,
        path: ['entry'],
      });
    }

    if (Object.hasOwn(checker, 'extensions')) {
      ctx.addIssue({
        code: 'custom',
        message: checkerExtensionsConfigReason,
        path: ['extensions'],
      });
    }

    if (Object.hasOwn(checker, 'routes')) {
      ctx.addIssue({
        code: 'custom',
        message: checkerRoutesConfigReason,
        path: ['routes'],
      });
    }

    if (typeof preset !== 'string' || preset.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'checker preset must be a non-empty string.',
        path: ['preset'],
      });
    } else if (!getCheckerAdapter(preset)) {
      ctx.addIssue({
        code: 'custom',
        message: unsupportedCheckerPresetReason,
        path: ['preset'],
      });
    }

    if (!Array.isArray(include) || include.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'checker include must be a non-empty string array.',
        path: ['include'],
      });
    } else {
      for (const [index, value] of include.entries()) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'checker include entries must be non-empty string paths.',
            path: ['include', index],
          });
        }
      }
    }

    if (exclude === undefined) {
      return;
    }

    if (!Array.isArray(exclude)) {
      ctx.addIssue({
        code: 'custom',
        message: 'checker exclude must be a string array when configured.',
        path: ['exclude'],
      });
      return;
    }

    for (const [index, value] of exclude.entries()) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'checker exclude entries must be non-empty string paths.',
          path: ['exclude', index],
        });
      }
    }
  });

function isPlainConfigRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSourcePatternConfig(options: {
  ctx: z.RefinementCtx;
  field: 'exclude' | 'include';
  source: Record<string, unknown>;
}): void {
  const patterns = options.source[options.field];

  if (patterns === undefined) {
    return;
  }

  if (!Array.isArray(patterns) || patterns.length === 0) {
    options.ctx.addIssue({
      code: 'custom',
      message: `config.source.${options.field} must be a non-empty string array.`,
      path: ['source', options.field],
    });
    return;
  }

  let defaultTokenCount = 0;

  for (const [index, value] of patterns.entries()) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      options.ctx.addIssue({
        code: 'custom',
        message: `config.source.${options.field} entries must be non-empty strings.`,
        path: ['source', options.field, index],
      });
      continue;
    }

    if (value === '...') {
      defaultTokenCount += 1;
    }
  }

  if (defaultTokenCount > 1) {
    options.ctx.addIssue({
      code: 'custom',
      message: `config.source.${options.field} may contain "..." at most once.`,
      path: ['source', options.field],
    });
  }
}

const sharedLiminaConfigShapeSchema = z
  .looseObject({})
  .superRefine((sharedConfig, ctx) => {
    const checkers = sharedConfig.checkers;
    const imports = sharedConfig.imports;
    const source = sharedConfig.source;

    if (checkers !== undefined) {
      if (checkers === 'auto') {
        ctx.addIssue({
          code: 'custom',
          message: checkerAutoStringConfigReason,
          path: ['checkers'],
        });
      } else if (!isPlainConfigRecord(checkers)) {
        ctx.addIssue({
          code: 'custom',
          message: checkerConfigReason,
          path: ['checkers'],
        });
      } else if (Object.hasOwn(checkers, 'mode')) {
        if (checkers.mode !== 'auto') {
          ctx.addIssue({
            code: 'custom',
            message: autoCheckerModeConfigReason,
            path: ['checkers', 'mode'],
          });
        }

        const exclude = checkers.exclude;

        if (exclude !== undefined && !Array.isArray(exclude)) {
          ctx.addIssue({
            code: 'custom',
            message:
              'auto checker exclude must be a string array when configured.',
            path: ['checkers', 'exclude'],
          });
        } else if (Array.isArray(exclude)) {
          for (const [index, value] of exclude.entries()) {
            if (typeof value !== 'string' || value.trim().length === 0) {
              ctx.addIssue({
                code: 'custom',
                message:
                  'auto checker exclude entries must be non-empty string paths.',
                path: ['checkers', 'exclude', index],
              });
            }
          }
        }

        for (const key of Object.keys(checkers)) {
          if (key === 'mode' || key === 'exclude') {
            continue;
          }

          ctx.addIssue({
            code: 'custom',
            message: autoCheckerMixedConfigReason,
            path: ['checkers', key],
          });
        }
      } else {
        for (const [checkerName, checker] of Object.entries(checkers)) {
          const result = checkerConfigShapeSchema.safeParse(checker);

          if (result.success) {
            continue;
          }

          for (const issue of result.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['checkers', checkerName, ...issue.path],
            });
          }
        }
      }
    }

    if (imports !== undefined) {
      if (!isPlainConfigRecord(imports)) {
        ctx.addIssue({
          code: 'custom',
          message: importAnalysisConfigReason,
          path: ['imports'],
        });
      } else if (
        imports.vue !== undefined &&
        imports.vue !== 'heuristic' &&
        imports.vue !== 'compiler-sfc'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: vueImportParserConfigReason,
          path: ['imports', 'vue'],
        });
      }
    }

    if (source === undefined) {
      return;
    }

    if (!isPlainConfigRecord(source)) {
      ctx.addIssue({
        code: 'custom',
        message: 'source boundary config must be an object.',
        path: ['source'],
      });
      return;
    }

    for (const key of Object.keys(source)) {
      if (key === 'include' || key === 'exclude') {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'unknown source boundary config field.',
        path: ['source', key],
      });
    }

    validateSourcePatternConfig({
      ctx,
      field: 'include',
      source,
    });
    validateSourcePatternConfig({
      ctx,
      field: 'exclude',
      source,
    });
  });

const releaseContentHashShapeSchema = z
  .looseObject({})
  .superRefine((contentHash, ctx) => {
    const baselineTag = contentHash.baselineTag;

    if (
      baselineTag !== undefined &&
      typeof baselineTag !== 'function' &&
      (typeof baselineTag !== 'string' || baselineTag.trim().length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'baselineTag must be a non-empty string or function.',
        path: ['baselineTag'],
      });
    }

    const builtinIgnore = contentHash.builtinIgnore;

    if (builtinIgnore !== undefined && typeof builtinIgnore !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        message: 'builtinIgnore must be a boolean.',
        path: ['builtinIgnore'],
      });
    }

    const ignore = contentHash.ignore;

    if (ignore === undefined || typeof ignore === 'function') {
      return;
    }

    if (!Array.isArray(ignore)) {
      ctx.addIssue({
        code: 'custom',
        message: 'ignore must be an array of non-empty strings or function.',
        path: ['ignore'],
      });
      return;
    }

    for (const [index, pattern] of ignore.entries()) {
      if (typeof pattern === 'string' && pattern.trim().length > 0) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'ignore patterns must be non-empty strings.',
        path: ['ignore', index],
      });
    }
  });

const releaseConfigShapeSchema = z.looseObject({
  contentHash: releaseContentHashShapeSchema.optional(),
});

const executionConcurrencyFields = [
  'tasks',
  'checkerBuild',
  'checkerTypecheck',
  'packageEntries',
  'releaseEntries',
] as const;

function isValidExecutionConcurrencyValue(value: unknown): boolean {
  return (
    value === 'auto' ||
    (typeof value === 'number' && Number.isInteger(value) && value > 0)
  );
}

const executionConfigShapeSchema = z
  .looseObject({})
  .superRefine((execution, ctx) => {
    for (const key of Object.keys(execution)) {
      if (key === 'failFast') {
        ctx.addIssue({
          code: 'custom',
          message:
            'execution.failFast was removed in Limina 0.2.0; remove this field and use pipeline dependency/stop-policy semantics.',
          path: [key],
        });
        continue;
      }

      if (
        executionConcurrencyFields.includes(
          key as (typeof executionConcurrencyFields)[number],
        )
      ) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'unknown execution config field.',
        path: [key],
      });
    }

    for (const key of executionConcurrencyFields) {
      const value = execution[key];

      if (value === undefined || isValidExecutionConcurrencyValue(value)) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'execution concurrency must be a positive integer or "auto".',
        path: [key],
      });
    }
  });

interface ConfigValidationContext {
  addIssue(issue: {
    code: 'custom';
    message: string;
    path: PropertyKey[];
  }): void;
}

function validateStringArrayField(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  required?: boolean;
  value: unknown;
  valueName: string;
}): boolean {
  if (options.value === undefined) {
    if (options.required) {
      options.ctx.addIssue({
        code: 'custom',
        message: `${options.valueName} must be a non-empty string array.`,
        path: options.path,
      });
    }

    return false;
  }

  if (!Array.isArray(options.value) || options.value.length === 0) {
    options.ctx.addIssue({
      code: 'custom',
      message: `${options.valueName} must be a non-empty string array.`,
      path: options.path,
    });
    return false;
  }

  for (const [index, item] of options.value.entries()) {
    if (typeof item === 'string' && item.trim().length > 0) {
      continue;
    }

    options.ctx.addIssue({
      code: 'custom',
      message: `${options.valueName} entries must be non-empty strings.`,
      path: [...options.path, index],
    });
  }

  return true;
}

function validateSourceImportAuthorityConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) {
    return;
  }

  if (!isPlainConfigRecord(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'importAuthority must be an object.',
      path: ['source', 'importAuthority'],
    });
    return;
  }

  const allow = value.allow;

  if (allow === undefined) {
    return;
  }

  if (Array.isArray(allow) || !isPlainConfigRecord(allow)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'allow must be an object keyed by source owner identity.\n  fix: use allow: { "@scope/package": [{ include: ["test/**/*.ts"], workspaceRootDependencies: ["@example/fixture"], reason: "..." }] }.',
      path: ['source', 'importAuthority', 'allow'],
    });
    return;
  }

  for (const [ownerIdentity, grants] of Object.entries(allow)) {
    const ownerPath = ['source', 'importAuthority', 'allow', ownerIdentity];

    if (ownerIdentity.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'allow keys must be non-empty source owner identities.',
        path: ownerPath,
      });
    }

    if (!Array.isArray(grants)) {
      ctx.addIssue({
        code: 'custom',
        message: 'allow owner entries must be arrays of grants.',
        path: ownerPath,
      });
      continue;
    }

    for (const [index, grant] of grants.entries()) {
      const grantPath = [...ownerPath, index];

      if (!isPlainConfigRecord(grant)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'importAuthority allow grants must be objects with workspaceRootDependencies and reason fields.',
          path: grantPath,
        });
        continue;
      }

      if (Object.hasOwn(grant, 'files')) {
        ctx.addIssue({
          code: 'custom',
          message:
            'files has been replaced by owner-root-relative include.\n  fix: move the source owner into the allow object key and replace workspace-root-relative files with owner-root-relative include.',
          path: [...grantPath, 'files'],
        });
      }

      if (Object.hasOwn(grant, 'packages')) {
        ctx.addIssue({
          code: 'custom',
          message:
            'packages has been replaced by workspaceRootDependencies.\n  fix: rename packages to workspaceRootDependencies.',
          path: [...grantPath, 'packages'],
        });
      }

      if (Object.hasOwn(grant, 'specifiers')) {
        ctx.addIssue({
          code: 'custom',
          message:
            'direct specifier authority is not part of the workspace root dependency authority model.',
          path: [...grantPath, 'specifiers'],
        });
      }

      if (Object.hasOwn(grant, 'owner')) {
        ctx.addIssue({
          code: 'custom',
          message: 'owner is now expressed by the allow object key.',
          path: [...grantPath, 'owner'],
        });
      }

      validateStringArrayField({
        ctx,
        path: [...grantPath, 'workspaceRootDependencies'],
        required: true,
        value: grant.workspaceRootDependencies,
        valueName: 'workspaceRootDependencies',
      });

      validateStringArrayField({
        ctx,
        path: [...grantPath, 'include'],
        value: grant.include,
        valueName: 'include',
      });

      if (
        typeof grant.reason !== 'string' ||
        grant.reason.trim().length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'reason must be a non-empty string.',
          path: [...grantPath, 'reason'],
        });
      }
    }
  }
}

function validateSourceDeclarationsConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  const declarationsPath = ['source', 'declarations'];
  if (!isPlainConfigRecord(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'declarations must be an object.',
      path: declarationsPath,
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'ambient')
      ctx.addIssue({
        code: 'custom',
        message: 'unknown source declarations config field.',
        path: [...declarationsPath, key],
      });
  }
  if (value.ambient === undefined) return;
  const ambientPath = [...declarationsPath, 'ambient'];
  if (!Array.isArray(value.ambient)) {
    ctx.addIssue({
      code: 'custom',
      message: 'ambient must be an array.',
      path: ambientPath,
    });
    return;
  }
  for (const [index, rule] of value.ambient.entries()) {
    const rulePath = [...ambientPath, index];
    if (!isPlainConfigRecord(rule)) {
      ctx.addIssue({
        code: 'custom',
        message: 'ambient declaration rules must be objects.',
        path: rulePath,
      });
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (
        ![
          'include',
          'allowSharedAcrossOwners',
          'allowTripleSlashReferences',
          'reason',
        ].includes(key)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'unknown ambient declaration rule field.',
          path: [...rulePath, key],
        });
      }
    }
    validateStringArrayField({
      ctx,
      path: [...rulePath, 'include'],
      required: true,
      value: rule.include,
      valueName: 'ambient declaration include',
    });
    if (typeof rule.reason !== 'string' || rule.reason.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'ambient declaration reason must be a non-empty string.',
        path: [...rulePath, 'reason'],
      });
    }
    for (const key of [
      'allowSharedAcrossOwners',
      'allowTripleSlashReferences',
    ] as const) {
      if (rule[key] !== undefined && typeof rule[key] !== 'boolean') {
        ctx.addIssue({
          code: 'custom',
          message: `${key} must be a boolean.`,
          path: [...rulePath, key],
        });
      }
    }
  }
}

const regionExcludeKinds = [
  'workspace-package',
  'package-scope',
  'pnpm-workspace',
] as const;

function validateRegionsConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) {
    return;
  }

  if (!isPlainConfigRecord(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'regions config must be an object.',
      path: ['regions'],
    });
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === 'exclude' || key === 'extendNestedPackageScopes') {
      continue;
    }

    ctx.addIssue({
      code: 'custom',
      message: 'unknown regions config field.',
      path: ['regions', key],
    });
  }

  if (
    value.extendNestedPackageScopes !== undefined &&
    typeof value.extendNestedPackageScopes !== 'boolean'
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'regions.extendNestedPackageScopes must be a boolean.',
      path: ['regions', 'extendNestedPackageScopes'],
    });
  }

  const exclude = value.exclude;

  if (exclude === undefined) {
    return;
  }

  if (!Array.isArray(exclude)) {
    ctx.addIssue({
      code: 'custom',
      message: 'regions.exclude must be an array.',
      path: ['regions', 'exclude'],
    });
    return;
  }

  for (const [index, entry] of exclude.entries()) {
    const entryPath = ['regions', 'exclude', index];

    if (!isPlainConfigRecord(entry)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'regions.exclude entries must be objects with kind, include, and reason fields.',
        path: entryPath,
      });
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (key === 'include' || key === 'kind' || key === 'reason') {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'unknown regions.exclude entry field.',
        path: [...entryPath, key],
      });
    }

    if (!Object.hasOwn(entry, 'kind')) {
      ctx.addIssue({
        code: 'custom',
        message: `regions.exclude[${index}].kind is required.`,
        path: [...entryPath, 'kind'],
      });
    } else if (
      typeof entry.kind !== 'string' ||
      !regionExcludeKinds.includes(
        entry.kind as (typeof regionExcludeKinds)[number],
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: [
          `regions.exclude[${index}].kind must be one of:`,
          ...regionExcludeKinds.map((kind) => `  ${kind}`),
        ].join('\n'),
        path: [...entryPath, 'kind'],
      });
    }

    validateStringArrayField({
      ctx,
      path: [...entryPath, 'include'],
      required: true,
      value: entry.include,
      valueName: 'regions.exclude.include',
    });

    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'reason must be a non-empty string.',
        path: [...entryPath, 'reason'],
      });
    }
  }
}

const liminaConfigShapeSchema = z
  .looseObject({
    config: sharedLiminaConfigShapeSchema.optional(),
    execution: executionConfigShapeSchema.optional(),
    regions: z.unknown().optional(),
    release: releaseConfigShapeSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if (Object.hasOwn(config, 'paths')) {
      ctx.addIssue({
        code: 'custom',
        message:
          'paths config has been removed; use graph/proof/source checks instead.',
        path: ['paths'],
      });
    }

    validateRegionsConfig(config.regions, ctx);

    const source = config.source;

    if (source === undefined) {
      return;
    }

    if (!isPlainConfigRecord(source)) {
      ctx.addIssue({
        code: 'custom',
        message: 'source config must be an object.',
        path: ['source'],
      });
      return;
    }

    for (const key of Object.keys(source)) {
      if (
        key === 'knip' ||
        key === 'importAuthority' ||
        key === 'declarations'
      ) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        message: 'unknown source config field.',
        path: ['source', key],
      });
    }

    validateSourceImportAuthorityConfig(source.importAuthority, ctx);
    validateSourceDeclarationsConfig(source.declarations, ctx);
  });

function formatZodPath(pathSegments: readonly PropertyKey[]): string {
  return pathSegments
    .map((segment) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : /^[A-Za-z_$][\w$]*$/u.test(String(segment))
          ? `.${String(segment)}`
          : `[${JSON.stringify(String(segment))}]`,
    )
    .join('')
    .replace(/^\./u, '');
}

function getValueAtPath(
  value: unknown,
  pathSegments: readonly PropertyKey[],
): unknown {
  let current = value;

  for (const segment of pathSegments) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

function formatLiminaConfigShapeIssue(
  value: unknown,
  issue: z.core.$ZodIssue,
): string {
  const pathSegments = issue.path as PropertyKey[];
  const field = formatZodPath(pathSegments);

  if (pathSegments.length === 0) {
    return 'limina config must export or return an object.';
  }

  if (field === 'config') {
    return [
      'Invalid Limina config:',
      '  field: config',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: config must be an object.',
    ].join('\n');
  }

  if (field === 'paths') {
    return [
      'Invalid Limina paths config:',
      '  field: paths',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'execution') {
    return [
      'Invalid Limina execution config:',
      '  field: execution',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: execution must be an object.',
    ].join('\n');
  }

  if (field === 'execution.failFast') {
    return [
      'Invalid Limina execution config:',
      '  field: execution.failFast',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field.startsWith('execution.')) {
    return [
      'Invalid Limina execution config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'config.checkers') {
    return [
      'Invalid Limina checker config:',
      '  field: config.checkers',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'config.checkers.mode') {
    return [
      'Invalid Limina checker config:',
      '  field: config.checkers.mode',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field.startsWith('config.checkers.exclude')) {
    return [
      'Invalid Limina checker config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'config.imports' || field.startsWith('config.imports.')) {
    return [
      'Invalid Limina import analysis config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'config.source' || field.startsWith('config.source.')) {
    return [
      'Invalid Limina source boundary config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (
    field === 'source.importAuthority' ||
    field.startsWith('source.importAuthority.')
  ) {
    return [
      'Invalid source import authority config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (field === 'source' || field.startsWith('source.')) {
    return [
      'Invalid Limina source config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      `  reason: ${issue.message}`,
    ].join('\n');
  }

  if (pathSegments[0] === 'config' && pathSegments[1] === 'checkers') {
    const checkerName = pathSegments[2];
    const checkerField = `config.checkers.${String(checkerName)}`;

    if (pathSegments.length === 3) {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${
          issue.message === autoCheckerMixedConfigReason
            ? issue.message
            : 'checker entries must be objects.'
        }`,
      ].join('\n');
    }

    if (pathSegments[3] === 'preset') {
      if (issue.message === unsupportedCheckerPresetReason) {
        return [
          'Unsupported Limina checker preset:',
          `  field: ${checkerField}.preset`,
          `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
          `  reason: ${issue.message}`,
        ].join('\n');
      }

      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.preset`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        '  reason: checker preset must be a non-empty string.',
      ].join('\n');
    }

    if (pathSegments[3] === 'entry') {
      return [
        'Invalid Limina checker entry config:',
        `  field: ${checkerField}.entry`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${issue.message}`,
      ].join('\n');
    }

    if (pathSegments[3] === 'extensions') {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.extensions`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${issue.message}`,
      ].join('\n');
    }

    if (pathSegments[3] === 'routes') {
      return [
        'Invalid Limina checker config:',
        `  field: ${checkerField}.routes`,
        `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
        `  reason: ${issue.message}`,
      ].join('\n');
    }
  }

  if (field === 'release') {
    return [
      'Invalid Limina release config:',
      '  field: release',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: release must be an object.',
    ].join('\n');
  }

  if (field === 'release.contentHash') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: release.contentHash must be an object.',
    ].join('\n');
  }

  if (field === 'release.contentHash.baselineTag') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.baselineTag',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: baselineTag must be a non-empty string or function.',
    ].join('\n');
  }

  if (field === 'release.contentHash.builtinIgnore') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.builtinIgnore',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: builtinIgnore must be a boolean.',
    ].join('\n');
  }

  if (field === 'release.contentHash.ignore') {
    return [
      'Invalid Limina release config:',
      '  field: release.contentHash.ignore',
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: ignore must be an array of non-empty strings or function.',
    ].join('\n');
  }

  if (
    pathSegments[0] === 'release' &&
    pathSegments[1] === 'contentHash' &&
    pathSegments[2] === 'ignore'
  ) {
    return [
      'Invalid Limina release config:',
      `  field: ${field}`,
      `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
      '  reason: ignore patterns must be non-empty strings.',
    ].join('\n');
  }

  return [
    'Invalid Limina config:',
    `  field: ${field}`,
    `  value: ${formatUnknownValue(getValueAtPath(value, pathSegments))}`,
    `  reason: ${issue.message}`,
  ].join('\n');
}

function collectLiminaConfigShapeProblems(value: unknown): string[] {
  const result = liminaConfigShapeSchema.safeParse(value);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) =>
    formatLiminaConfigShapeIssue(value, issue),
  );
}

export function validateLiminaConfig(config: LiminaConfig): void {
  const problems = collectLiminaConfigShapeProblems(config);

  if (problems.length > 0) {
    throw new ConfigurationError(
      problems.join('\n\n'),
      problems.map((message) => ({ message, path: [] })),
    );
  }
}
