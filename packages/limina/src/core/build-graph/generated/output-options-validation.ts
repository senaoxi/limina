import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import path from 'pathe';
import type { OutputOptionsProblem } from './config-reader-types';

export interface OutputReaderContext {
  config: ResolvedLiminaConfig;
  diagnostics: OutputOptionsProblem[];
  problems: string[];
  sourceConfigPath: string;
}

export type OptionalRecordResult =
  | { kind: 'absent' | 'invalid' }
  | { kind: 'value'; value: Record<string, unknown> };

const stringFields = ['outDir', 'rootDir', 'target'] as const;
const allowedFields = new Set([...stringFields, 'declarationMap']);

export type OutputStringField = (typeof stringFields)[number];

function getValueDetail(options: { value?: unknown }): string[] {
  return Object.hasOwn(options, 'value')
    ? [`  value: ${formatUnknownValue(options.value)}`]
    : [];
}

function addOutputOptionsProblem(
  context: OutputReaderContext,
  options: { field: string; reason: string; value?: unknown },
): void {
  const detailLines = [
    'Invalid Limina output options:',
    `  config: ${toRelativePath(context.config.rootDir, context.sourceConfigPath)}`,
    `  field: ${options.field}`,
    ...getValueDetail(options),
    `  reason: ${options.reason}`,
  ];
  context.problems.push(detailLines.join('\n'));
  context.diagnostics.push({
    detailLines,
    field: options.field,
    reason: options.reason,
    sourceConfigPath: context.sourceConfigPath,
    ...(Object.hasOwn(options, 'value') ? { value: options.value } : {}),
  });
}

function parseOptionalRecord(options: {
  context: OutputReaderContext;
  field: string;
  reason: string;
  value: unknown;
}): OptionalRecordResult {
  if (options.value === undefined) {
    return { kind: 'absent' };
  }

  if (isPlainRecord(options.value)) {
    return { kind: 'value', value: options.value };
  }

  addOutputOptionsProblem(options.context, {
    field: options.field,
    reason: options.reason,
    value: options.value,
  });
  return { kind: 'invalid' };
}

export function resolveOutputRecord(
  configObject: Record<string, unknown>,
  context: OutputReaderContext,
): OptionalRecordResult {
  const liminaOptions = parseOptionalRecord({
    context,
    field: 'liminaOptions',
    reason: 'liminaOptions must be an object before outputs can be read.',
    value: configObject.liminaOptions,
  });
  if (liminaOptions.kind !== 'value') {
    return liminaOptions;
  }

  return parseOptionalRecord({
    context,
    field: 'liminaOptions.outputs',
    reason: 'outputs must be an object.',
    value: liminaOptions.value.outputs,
  });
}

export function validateAllowedFields(
  outputs: Record<string, unknown>,
  context: OutputReaderContext,
): void {
  for (const fieldName of Object.keys(outputs)) {
    if (!allowedFields.has(fieldName)) {
      addOutputOptionsProblem(context, {
        field: `liminaOptions.outputs.${fieldName}`,
        reason:
          'outputs only supports target, rootDir, outDir, and declarationMap.',
        value: outputs[fieldName],
      });
    }
  }
}

function isOutputPathField(fieldName: OutputStringField): boolean {
  return fieldName === 'rootDir' || fieldName === 'outDir';
}

function validateRelativeOutputPath(options: {
  context: OutputReaderContext;
  fieldName: OutputStringField;
  value: string;
}): boolean {
  if (!isOutputPathField(options.fieldName)) {
    return true;
  }

  if (!path.isAbsolute(options.value)) {
    return true;
  }

  addOutputOptionsProblem(options.context, {
    field: `liminaOptions.outputs.${options.fieldName}`,
    reason:
      'output path fields must be relative to the tsconfig that declares them.',
    value: options.value,
  });
  return false;
}

function normalizeStringOutputValue(options: {
  context: OutputReaderContext;
  fieldName: OutputStringField;
  value: string;
}): string | undefined {
  return validateRelativeOutputPath(options) ? options.value.trim() : undefined;
}

function readStringOutputField(options: {
  context: OutputReaderContext;
  fieldName: OutputStringField;
  outputs: Record<string, unknown>;
}): string | undefined {
  const value = options.outputs[options.fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (!isNonEmptyString(value)) {
    addOutputOptionsProblem(options.context, {
      field: `liminaOptions.outputs.${options.fieldName}`,
      reason: 'output option fields must be non-empty strings.',
      value,
    });
    return undefined;
  }

  return normalizeStringOutputValue({
    context: options.context,
    fieldName: options.fieldName,
    value,
  });
}

export function readStringOutputFields(
  outputs: Record<string, unknown>,
  context: OutputReaderContext,
): Partial<Record<OutputStringField, string>> {
  const values: Partial<Record<OutputStringField, string>> = {};

  for (const fieldName of stringFields) {
    const value = readStringOutputField({ context, fieldName, outputs });
    if (value !== undefined) {
      values[fieldName] = value;
    }
  }

  return values;
}

export function readDeclarationMap(
  outputs: Record<string, unknown>,
  context: OutputReaderContext,
): boolean {
  const value = outputs.declarationMap;
  if (value === undefined) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  addOutputOptionsProblem(context, {
    field: 'liminaOptions.outputs.declarationMap',
    reason: 'declarationMap must be a boolean.',
    value,
  });
  return false;
}
