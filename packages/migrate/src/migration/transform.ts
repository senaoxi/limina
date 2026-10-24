import {
  applyEdits,
  type FormattingOptions,
  type ModificationOptions,
  modify,
} from 'jsonc-parser';
import type { ResolvedLiminaInputs } from 'limina/internal/config/runner';
import {
  createLiminaTsconfigSchemaPath,
  type JsonObject,
} from 'limina/internal/core/tsconfig/actions';
import { isPlainRecord } from 'limina/internal/utils/values';
import path from 'pathe';
import { deleteJsoncProperty } from './jsonc-delete';
import {
  assertMigrationTextMatchesPlan,
  assertUnambiguousMigrationText,
} from './jsonc-validation';
import type { MigrationWritePlanItem } from './transaction';
import type { MigrationEffectiveConfig, MigrationTarget } from './types';

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

function collectMigrationEdits(
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

function applyMigratedTsconfigText(options: {
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
        ...(edit.path[0] === '$schema' && {
          modification: { getInsertionIndex: () => 0 },
        }),
      }),
    options.originalContent,
  );
}

function collectChangedValue(
  left: unknown,
  right: unknown,
  path: string[],
): { path: string[]; value: unknown }[] {
  return isPlainRecord(left) && isPlainRecord(right)
    ? collectMigrationEdits(left, right, path)
    : [{ path, value: right }];
}

export function relativeConfigPath(configPath: string, target: string): string {
  const relative = path.relative(path.dirname(configPath), target) || '.';
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function hasExistingOutputs(target: MigrationTarget): boolean {
  const metadata = target.configObject.liminaOptions;
  return isPlainRecord(metadata) && Object.hasOwn(metadata, 'outputs');
}

function hasSplitOutputs(
  options: MigrationEffectiveConfig['options'],
): boolean {
  return (
    !(!options.declarationDir || !options.outDir) &&
    path.resolve(options.declarationDir) !== path.resolve(options.outDir)
  );
}

export function outputAdoptionRejectionReason(
  target: MigrationTarget,
): string | undefined {
  const options = target.effectiveConfig.options;
  const reasons: [boolean, string][] = [
    [
      target.isTypeScriptSolution,
      'Solution compiler options do not enable managed output.',
    ],
    [
      hasExistingOutputs(target),
      'Preserved the existing explicit output contract.',
    ],
    [
      options.noEmit === true,
      'Effective noEmit is true; managed emit was not enabled.',
    ],
    [
      Boolean(options.emitDeclarationOnly),
      'Declaration-only emission was not adopted.',
    ],
    [Boolean(options.outFile), 'outFile emission was not adopted.'],
    [
      hasSplitOutputs(options),
      'Split declaration and JavaScript directories were not adopted.',
    ],
    [!options.outDir, 'No effective outDir supplies automatic output intent.'],
  ];
  return reasons.find(([reject]) => reject)?.[1];
}

/**
Optional proposal only. The planner must check visibility and membership.
*/
export function proposeOutputAdoption(
  target: MigrationTarget,
): JsonObject | undefined {
  return outputAdoptionRejectionReason(target)
    ? undefined
    : createOutputProposal(target);
}

function createOutputProposal(target: MigrationTarget): JsonObject {
  const options = target.effectiveConfig.options;
  const output: JsonObject = {
    outDir: relativeConfigPath(target.configPath, options.outDir!),
  };
  if (options.rootDir)
    output.rootDir = relativeConfigPath(target.configPath, options.rootDir);
  if (options.declarationMap !== undefined)
    output.declarationMap = options.declarationMap;
  return output;
}

export function migrateTsconfigObject(options: {
  configObject: JsonObject;
  configPath: string;
  effectiveConfig?: MigrationEffectiveConfig;
  isLiminaSolution: boolean;
  rootDir: string;
}): JsonObject {
  const next = structuredClone(options.configObject);
  next.$schema = createLiminaTsconfigSchemaPath(
    options.rootDir,
    options.configPath,
  );
  if (!options.isLiminaSolution) delete next.references;
  return next;
}

export function createMigrationWritePlanItem(options: {
  config: ResolvedLiminaInputs;
  target: MigrationTarget;
  migratedConfig?: JsonObject;
}): MigrationWritePlanItem {
  const next =
    options.migratedConfig ??
    migrateTsconfigObject({
      ...options.target,
      rootDir: options.config.rootDir,
    });
  const edits = collectMigrationEdits(options.target.configObject, next);
  assertUnambiguousMigrationText(
    options.target.originalContent,
    edits.map((edit) => edit.path),
  );
  const nextContent = applyMigratedTsconfigText({
    ...options.target,
    migratedConfig: next,
  });
  assertMigrationTextMatchesPlan(nextContent, next);
  return {
    configPath: options.target.configPath,
    nextContent,
    originalBytes: options.target.originalBytes,
    originalContent: options.target.originalContent,
    status:
      options.target.originalContent === nextContent ? 'skipped' : 'modified',
  };
}
