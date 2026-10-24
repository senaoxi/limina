import type { ResolvedLiminaInputs } from '#config/runner';
import { type JsonObject, readJsonConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import path from 'pathe';
import { readExplicitSourceCompilerTarget } from './compiler-target';

export interface OutputOptions {
  declarationMap: boolean;
  outDir: string;
  rootDir: string;
  target: string;
}

export interface OutputOptionsProblem {
  readonly detailLines: readonly string[];
  readonly field: string;
  readonly reason: string;
  readonly sourceConfigPath: string;
  readonly value?: unknown;
}

interface OutputReaderContext {
  config: ResolvedLiminaInputs;
  diagnostics: OutputOptionsProblem[];
  problems: string[];
  sourceConfigPath: string;
}

type OptionalRecordResult =
  | { kind: 'absent' | 'invalid' }
  | { kind: 'value'; value: Record<string, unknown> };

const stringFields = ['outDir', 'rootDir', 'target'] as const;
const allowedFields = new Set([...stringFields, 'declarationMap']);

type OutputStringField = (typeof stringFields)[number];

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
    ...(Object.hasOwn(options, 'value') && { value: options.value }),
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

function resolveOutputRecord(
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

function validateAllowedFields(
  outputs: Record<string, unknown>,
  context: OutputReaderContext,
): void {
  for (const [fieldName, value] of Object.entries(outputs)) {
    if (!allowedFields.has(fieldName)) {
      addOutputOptionsProblem(context, {
        field: `liminaOptions.outputs.${fieldName}`,
        reason:
          'outputs only supports target, rootDir, outDir, and declarationMap.',
        value,
      });
    }
  }
}

function isOutputPathField(fieldName: OutputStringField): boolean {
  return fieldName === 'rootDir' || fieldName === 'outDir';
}

function isValidateRelativeOutputPath(options: {
  context: OutputReaderContext;
  fieldName: OutputStringField;
  value: string;
}): boolean {
  if (
    !isOutputPathField(options.fieldName) ||
    !path.isAbsolute(options.value)
  ) {
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
  return isValidateRelativeOutputPath(options)
    ? options.value.trim()
    : undefined;
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

function readStringOutputFields(
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

function isReadDeclarationMap(
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

function resolveOutputTarget(options: {
  config: ResolvedLiminaInputs;
  configuredTarget: string | undefined;
  sourceConfigPath: string;
}): string {
  if (options.configuredTarget !== undefined) {
    return options.configuredTarget;
  }

  return (
    readExplicitSourceCompilerTarget({
      config: options.config,
      configPath: options.sourceConfigPath,
    }) ?? 'ESNext'
  );
}

function resolveOutputPath(
  sourceDirectory: string,
  configuredPath: string | undefined,
  fallbackPath: string,
): string {
  return normalizeAbsolutePath(
    path.resolve(sourceDirectory, configuredPath ?? fallbackPath),
  );
}

function createOutputOptions(options: {
  config: ResolvedLiminaInputs;
  declarationMap: boolean;
  sourceConfigPath: string;
  values: Partial<Record<OutputStringField, string>>;
}): OutputOptions {
  const sourceDirectory = path.dirname(options.sourceConfigPath);
  return {
    declarationMap: options.declarationMap,
    outDir: resolveOutputPath(sourceDirectory, options.values.outDir, './dist'),
    rootDir: resolveOutputPath(sourceDirectory, options.values.rootDir, '.'),
    target: resolveOutputTarget({
      config: options.config,
      configuredTarget: options.values.target,
      sourceConfigPath: options.sourceConfigPath,
    }),
  };
}

function createEmptyResult(context: OutputReaderContext): {
  diagnostics: OutputOptionsProblem[];
  outputs: null;
  problems: string[];
} {
  return {
    diagnostics: context.diagnostics,
    outputs: null,
    problems: context.problems,
  };
}

function createOutputResult(options: {
  context: OutputReaderContext;
  declarationMap: boolean;
  values: Partial<Record<OutputStringField, string>>;
}): {
  diagnostics: OutputOptionsProblem[];
  outputs: OutputOptions | null;
  problems: string[];
} {
  return {
    diagnostics: options.context.diagnostics,
    outputs:
      options.context.problems.length === 0
        ? createOutputOptions({
            config: options.context.config,
            declarationMap: options.declarationMap,
            sourceConfigPath: options.context.sourceConfigPath,
            values: options.values,
          })
        : null,
    problems: options.context.problems,
  };
}

export function readOutputOptions(
  config: ResolvedLiminaInputs,
  sourceConfigPath: string,
  configObject: JsonObject = readJsonConfig(config, sourceConfigPath),
): {
  diagnostics: OutputOptionsProblem[];
  outputs: OutputOptions | null;
  problems: string[];
} {
  const context: OutputReaderContext = {
    config,
    diagnostics: [],
    problems: [],
    sourceConfigPath,
  };
  const outputRecord = resolveOutputRecord(configObject, context);
  if (outputRecord.kind !== 'value') {
    return createEmptyResult(context);
  }

  validateAllowedFields(outputRecord.value, context);
  return createOutputResult({
    context,
    declarationMap: isReadDeclarationMap(outputRecord.value, context),
    values: readStringOutputFields(outputRecord.value, context),
  });
}
