import { z } from 'zod';
import { checkerConfigKeys } from './checker-schema-constants';
import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isAbsolutePublicSelector,
  isNonEmptyString,
} from './shared';

function validateCheckerSelectorEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
  value: unknown;
}): void {
  if (!isNonEmptyString(options.value)) {
    addConfigIssue(
      options.ctx,
      [options.field, options.index],
      `checker ${options.field} entries must be non-empty string paths.`,
    );
    return;
  }
  if (!isAbsolutePublicSelector(options.value)) return;
  addConfigIssue(
    options.ctx,
    [options.field, options.index],
    `checker ${options.field} entries must be config.rootDir-relative paths; ../ is allowed.`,
  );
}

function handleMissingSelector(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): null {
  if (!options.required) return null;
  addConfigIssue(
    options.ctx,
    [options.field],
    `checker ${options.field} must be a non-empty string array.`,
  );
  return null;
}

function validateSelectorArrayShape(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
  value: unknown[];
}): unknown[] | null {
  if (!options.required || options.value.length > 0) return options.value;
  addConfigIssue(
    options.ctx,
    [options.field],
    'checker include must be a non-empty string array.',
  );
  return null;
}

function getCheckerSelectorArray(options: {
  checker: Record<string, unknown>;
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): unknown[] | null {
  const value = options.checker[options.field];
  if (value === undefined) return handleMissingSelector(options);
  if (Array.isArray(value)) {
    return validateSelectorArrayShape({ ...options, value });
  }
  addConfigIssue(
    options.ctx,
    [options.field],
    `checker ${options.field} must be a string array when configured.`,
  );
  return null;
}

function validateCheckerSelectorArray(options: {
  checker: Record<string, unknown>;
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): void {
  const values = getCheckerSelectorArray(options);
  if (values === null) return;
  for (const [index, value] of values.entries()) {
    validateCheckerSelectorEntry({
      ctx: options.ctx,
      field: options.field,
      index,
      value,
    });
  }
}

export const checkerConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({})
  .superRefine((checker, ctx) => {
    addUnknownFieldIssues({
      allowed: checkerConfigKeys,
      ctx,
      message: 'unknown checker config field.',
      path: [],
      value: checker,
    });
    validateCheckerSelectorArray({
      checker,
      ctx,
      field: 'include',
      required: true,
    });
    validateCheckerSelectorArray({
      checker,
      ctx,
      field: 'exclude',
      required: false,
    });
  });
