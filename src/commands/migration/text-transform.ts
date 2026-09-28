import type { JsonObject } from '#core/tsconfig/actions';
import { isPlainRecord } from '#utils/values';
import {
  applyEdits,
  type FormattingOptions,
  type ModificationOptions,
  modify,
} from 'jsonc-parser';
import { deleteJsoncProperty } from './jsonc-delete';

const compilerOutputFields = [
  'outDir',
  'rootDir',
  'declarationMap',
  'target',
] as const;
const governedCompilerOptionFields = [
  'composite',
  'declaration',
  'emitDeclarationOnly',
  'incremental',
  'noEmit',
  'tsBuildInfoFile',
] as const;

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function detectTabSize(indentation: string): number {
  return indentation.includes('\t') ? 1 : indentation.length;
}

function detectFormattingOptions(content: string): FormattingOptions {
  const indentation = /\r?\n([\t ]+)(?=")/u.exec(content)?.[1] ?? '  ';
  return {
    eol: detectEol(content),
    insertSpaces: !indentation.includes('\t'),
    tabSize: detectTabSize(indentation),
  };
}

function applyJsoncModification(options: {
  content: string;
  modification?: Pick<ModificationOptions, 'getInsertionIndex'>;
  path: readonly (number | string)[];
  value: unknown;
}): string {
  if (options.value === undefined) {
    return deleteJsoncProperty(options.content, options.path);
  }
  const edits = modify(options.content, [...options.path], options.value, {
    formattingOptions: detectFormattingOptions(options.content),
    ...options.modification,
  });
  return applyEdits(options.content, edits);
}

function getRecordField(
  config: JsonObject,
  field: string,
): Record<string, unknown> | undefined {
  const value = config[field];
  return isPlainRecord(value) ? value : undefined;
}

function getRecordChild(
  record: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  if (record === undefined) return undefined;
  const value = record[field];
  return isPlainRecord(value) ? value : undefined;
}

function hasOwnRecordField(
  record: Record<string, unknown> | undefined,
  field: string,
): boolean {
  return record !== undefined && Object.hasOwn(record, field);
}

function sourceHasDeclarationDirWithoutOutDir(
  compilerOptions: Record<string, unknown> | undefined,
): boolean {
  return (
    compilerOptions !== undefined &&
    Object.hasOwn(compilerOptions, 'declarationDir') &&
    !Object.hasOwn(compilerOptions, 'outDir')
  );
}

function migratedPlanIntroducesOutDir(options: {
  migratedOutputs: Record<string, unknown>;
  originalOutputs: Record<string, unknown> | undefined;
}): boolean {
  return (
    hasOwnRecordField(options.migratedOutputs, 'outDir') &&
    !hasOwnRecordField(options.originalOutputs, 'outDir')
  );
}

function shouldInsertDeclarationOnlyOutDir(options: {
  originalCompilerOptions: Record<string, unknown> | undefined;
  originalOutputs: Record<string, unknown> | undefined;
  migratedOutputs: Record<string, unknown>;
}): boolean {
  return (
    sourceHasDeclarationDirWithoutOutDir(options.originalCompilerOptions) &&
    migratedPlanIntroducesOutDir({
      migratedOutputs: options.migratedOutputs,
      originalOutputs: options.originalOutputs,
    })
  );
}

function applyMovedOutputField(options: {
  content: string;
  field: (typeof compilerOutputFields)[number];
  outputs: Record<string, unknown>;
}): string {
  return applyJsoncModification({
    content: options.content,
    path: ['liminaOptions', 'outputs', options.field],
    value: options.outputs[options.field],
  });
}

function hasMovedOutputEditInputs(options: {
  migratedOutputs: Record<string, unknown> | undefined;
  originalCompilerOptions: Record<string, unknown> | undefined;
}): options is {
  migratedOutputs: Record<string, unknown>;
  originalCompilerOptions: Record<string, unknown>;
} {
  return (
    options.originalCompilerOptions !== undefined &&
    options.migratedOutputs !== undefined
  );
}

function applyDeclarationOnlyOutDir(options: {
  content: string;
  migratedOutputs: Record<string, unknown>;
  originalCompilerOptions: Record<string, unknown>;
  originalOutputs: Record<string, unknown> | undefined;
}): string {
  if (
    !shouldInsertDeclarationOnlyOutDir({
      migratedOutputs: options.migratedOutputs,
      originalCompilerOptions: options.originalCompilerOptions,
      originalOutputs: options.originalOutputs,
    })
  ) {
    return options.content;
  }
  return applyMovedOutputField({
    content: options.content,
    field: 'outDir',
    outputs: options.migratedOutputs,
  });
}

function applyMovedOutputEdits(options: {
  content: string;
  originalConfig: JsonObject;
  migratedConfig: JsonObject;
}): string {
  const originalCompilerOptions = getRecordField(
    options.originalConfig,
    'compilerOptions',
  );
  const migratedLiminaOptions = getRecordField(
    options.migratedConfig,
    'liminaOptions',
  );
  const migratedOutputs = getRecordChild(migratedLiminaOptions, 'outputs');
  const editInputs = { migratedOutputs, originalCompilerOptions };
  if (!hasMovedOutputEditInputs(editInputs)) {
    return options.content;
  }
  const editableCompilerOptions = editInputs.originalCompilerOptions;
  const editableOutputs = editInputs.migratedOutputs;
  const movedFields = compilerOutputFields.filter((field) =>
    Object.hasOwn(editableCompilerOptions, field),
  );
  const movedContent = movedFields.reduce(
    (content, field) =>
      applyMovedOutputField({ content, field, outputs: editableOutputs }),
    options.content,
  );
  const originalOutputs = getRecordChild(
    getRecordField(options.originalConfig, 'liminaOptions'),
    'outputs',
  );
  return applyDeclarationOnlyOutDir({
    content: movedContent,
    migratedOutputs: editableOutputs,
    originalCompilerOptions: editableCompilerOptions,
    originalOutputs,
  });
}

function removeCompilerOptionField(content: string, field: string): string {
  return applyJsoncModification({
    content,
    path: ['compilerOptions', field],
    value: undefined,
  });
}

function removeCompilerOptions(content: string): string {
  return applyJsoncModification({
    content,
    path: ['compilerOptions'],
    value: undefined,
  });
}

function applyCompilerOptionEdits(options: {
  content: string;
  originalConfig: JsonObject;
  migratedConfig: JsonObject;
}): string {
  const originalCompilerOptions = getRecordField(
    options.originalConfig,
    'compilerOptions',
  );
  if (originalCompilerOptions === undefined) return options.content;
  if (options.migratedConfig.compilerOptions === undefined) {
    return removeCompilerOptions(options.content);
  }
  const removedFields = [
    ...compilerOutputFields,
    ...governedCompilerOptionFields,
    'declarationDir',
  ].filter((field) => Object.hasOwn(originalCompilerOptions, field));
  return removedFields.reduce(removeCompilerOptionField, options.content);
}

function applyReferenceEdit(options: {
  configObject: JsonObject;
  content: string;
  isLiminaSolution: boolean;
}): string {
  if (options.isLiminaSolution) return options.content;
  return Object.hasOwn(options.configObject, 'references')
    ? applyJsoncModification({
        content: options.content,
        path: ['references'],
        value: undefined,
      })
    : options.content;
}

export function applyMigratedTsconfigText(options: {
  configObject: JsonObject;
  isLiminaSolution: boolean;
  migratedConfig: JsonObject;
  originalContent: string;
}): string {
  const movedContent = applyMovedOutputEdits({
    content: options.originalContent,
    migratedConfig: options.migratedConfig,
    originalConfig: options.configObject,
  });
  const compilerContent = applyCompilerOptionEdits({
    content: movedContent,
    migratedConfig: options.migratedConfig,
    originalConfig: options.configObject,
  });
  const referenceContent = applyReferenceEdit({
    configObject: options.configObject,
    content: compilerContent,
    isLiminaSolution: options.isLiminaSolution,
  });
  return applyJsoncModification({
    content: referenceContent,
    modification: {
      getInsertionIndex: () => 0,
    },
    path: ['$schema'],
    value: options.migratedConfig.$schema,
  });
}
