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
  if (originalCompilerOptions === undefined) return options.content;
  if (migratedOutputs === undefined) return options.content;
  const movedFields = compilerOutputFields.filter((field) =>
    Object.hasOwn(originalCompilerOptions, field),
  );
  return movedFields.reduce(
    (content, field) =>
      applyMovedOutputField({ content, field, outputs: migratedOutputs }),
    options.content,
  );
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
  ].filter((field) => Object.hasOwn(originalCompilerOptions, field));
  return removedFields.reduce(removeCompilerOptionField, options.content);
}

function applyReferenceEdit(options: {
  configObject: JsonObject;
  content: string;
  isSolutionStyle: boolean;
}): string {
  if (options.isSolutionStyle) return options.content;
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
  isSolutionStyle: boolean;
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
    isSolutionStyle: options.isSolutionStyle,
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
