import {
  applyEdits,
  type FormattingOptions,
  type ModificationOptions,
  modify,
} from 'jsonc-parser';
import type { JsonObject } from 'limina/internal/migration';
import { isPlainRecord } from 'limina/internal/migration';
import { deleteJsoncProperty } from './jsonc-delete';

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

export function collectMigrationEdits(
  before: JsonObject,
  after: JsonObject,
  prefix: string[] = [],
): { path: string[]; value: unknown }[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (key) => {
      const left = before[key];
      const right = after[key];
      if (JSON.stringify(left) === JSON.stringify(right)) return [];
      const path = [...prefix, key];
      return collectChangedValue(left, right, path);
    },
  );
}

export function applyMigratedTsconfigText(options: {
  configObject: JsonObject;
  isLiminaSolution: boolean;
  migratedConfig: JsonObject;
  originalContent: string;
}): string {
  return collectMigrationEdits(
    options.configObject,
    options.migratedConfig,
  ).reduce(
    (content, edit) =>
      applyJsoncModification({
        content,
        ...edit,
        ...(edit.path[0] === '$schema'
          ? { modification: { getInsertionIndex: () => 0 } }
          : {}),
      }),
    options.originalContent,
  );
}

function collectChangedValue(
  left: unknown,
  right: unknown,
  path: string[],
): { path: string[]; value: unknown }[] {
  if (isPlainRecord(left) && isPlainRecord(right))
    return collectMigrationEdits(left, right, path);
  return [{ path, value: right }];
}
