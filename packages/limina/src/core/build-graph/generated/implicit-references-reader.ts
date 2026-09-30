import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isOrdinarySourceTypecheckConfigPath,
  readJsonConfig,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type { ImplicitReference } from './config-reader-types';
import type {
  ImplicitReferenceContext,
  ImplicitReferenceEntriesResult,
  ReferenceTargetValidationOptions,
  ReferenceTargetValidator,
} from './implicit-reference-types';

function getValueDetail(options: { value?: unknown }): string[] {
  return Object.hasOwn(options, 'value')
    ? [`  value: ${formatUnknownValue(options.value)}`]
    : [];
}

function addImplicitReferenceProblem(
  context: ImplicitReferenceContext,
  options: { field: string; reason: string; value?: unknown },
): void {
  context.problems.push(
    [
      'Invalid Limina implicit reference:',
      `  config: ${toRelativePath(context.config.rootDir, context.sourceConfigPath)}`,
      `  field: ${options.field}`,
      ...getValueDetail(options),
      `  reason: ${options.reason}`,
    ].join('\n'),
  );
}

function resolveImplicitReferenceEntries(
  configObject: Record<string, unknown>,
  context: ImplicitReferenceContext,
): ImplicitReferenceEntriesResult {
  const liminaOptions = configObject.liminaOptions;
  if (liminaOptions === undefined) {
    return { kind: 'absent' };
  }

  if (!isPlainRecord(liminaOptions)) {
    addImplicitReferenceProblem(context, {
      field: 'liminaOptions',
      reason:
        'liminaOptions must be an object before implicitRefs can be read.',
      value: liminaOptions,
    });
    return { kind: 'invalid' };
  }

  return resolveImplicitReferenceArray(liminaOptions.implicitRefs, context);
}

function resolveImplicitReferenceArray(
  value: unknown,
  context: ImplicitReferenceContext,
): ImplicitReferenceEntriesResult {
  if (value === undefined) {
    return { kind: 'absent' };
  }

  if (Array.isArray(value)) {
    return { entries: value, kind: 'value' };
  }

  addImplicitReferenceProblem(context, {
    field: 'liminaOptions.implicitRefs',
    reason:
      'implicitRefs must be an array of objects with non-empty path and reason fields.',
    value,
  });
  return { kind: 'invalid' };
}

function readRequiredString(options: {
  context: ImplicitReferenceContext;
  field: string;
  reason: string;
  value: unknown;
}): string | null {
  if (isNonEmptyString(options.value)) {
    return options.value.trim();
  }

  addImplicitReferenceProblem(options.context, {
    field: options.field,
    reason: options.reason,
    value: options.value,
  });
  return null;
}

const validateNotSelfReference: ReferenceTargetValidator = (options) =>
  options.targetConfigPath === options.sourceConfigPath
    ? 'implicitRefs must not reference the declaring tsconfig.'
    : null;

const validateExistingTarget: ReferenceTargetValidator = (options) =>
  existsSync(options.targetConfigPath)
    ? null
    : 'implicitRefs path must point to an existing ordinary source tsconfig.';

const validateOrdinarySourceTarget: ReferenceTargetValidator = (options) =>
  isOrdinarySourceTypecheckConfigPath(options.targetConfigPath, options.rootDir)
    ? null
    : 'implicitRefs path must point to an ordinary source tsconfig*.json file, not a generated, declaration, build, base, or check config.';

const targetValidators: readonly ReferenceTargetValidator[] = [
  validateNotSelfReference,
  validateExistingTarget,
  validateOrdinarySourceTarget,
];

function findTargetProblem(
  options: ReferenceTargetValidationOptions,
): string | null {
  for (const validate of targetValidators) {
    const problem = validate(options);
    if (problem !== null) {
      return problem;
    }
  }

  return null;
}

function isValidateRelativeReferencePath(options: {
  context: ImplicitReferenceContext;
  field: string;
  pathValue: string;
}): boolean {
  if (!path.isAbsolute(options.pathValue)) {
    return true;
  }

  addImplicitReferenceProblem(options.context, {
    field: options.field,
    reason:
      'implicitRefs path must be relative to the tsconfig that declares it.',
    value: options.pathValue,
  });
  return false;
}

function createValidatedImplicitReference(options: {
  context: ImplicitReferenceContext;
  field: string;
  pathValue: string;
  reasonValue: string;
}): ImplicitReference | null {
  if (!isValidateRelativeReferencePath(options)) {
    return null;
  }

  const targetConfigPath = resolveReferencePath(
    options.context.sourceConfigPath,
    options.pathValue,
  );
  const problem = findTargetProblem({
    rootDir: options.context.config.rootDir,
    sourceConfigPath: options.context.sourceConfigPath,
    targetConfigPath,
  });
  if (problem !== null) {
    addImplicitReferenceProblem(options.context, {
      field: `${options.field}.path`,
      reason: problem,
      value: options.pathValue,
    });
    return null;
  }

  return {
    path: options.pathValue,
    reason: options.reasonValue,
    targetConfigPath,
  };
}

function readImplicitReferenceEntry(options: {
  context: ImplicitReferenceContext;
  entry: unknown;
  index: number;
}): ImplicitReference | null {
  const field = `liminaOptions.implicitRefs[${options.index}]`;
  if (!isPlainRecord(options.entry)) {
    addImplicitReferenceProblem(options.context, {
      field,
      reason:
        'implicitRefs entries must be objects with non-empty path and reason fields.',
      value: options.entry,
    });
    return null;
  }

  return readImplicitReferenceRecord({
    context: options.context,
    entry: options.entry,
    field,
  });
}

function readImplicitReferenceRecord(options: {
  context: ImplicitReferenceContext;
  entry: Record<string, unknown>;
  field: string;
}): ImplicitReference | null {
  const pathValue = readRequiredString({
    context: options.context,
    field: `${options.field}.path`,
    reason: 'implicitRefs path is required and must be a non-empty string.',
    value: options.entry.path,
  });
  const reasonValue = readRequiredString({
    context: options.context,
    field: `${options.field}.reason`,
    reason: 'implicitRefs reason is required and must be a non-empty string.',
    value: options.entry.reason,
  });
  if (pathValue === null || reasonValue === null) {
    return null;
  }

  return createValidatedImplicitReference({
    context: options.context,
    field: options.field,
    pathValue,
    reasonValue,
  });
}

function addImplicitReferenceEntry(
  referencesByTarget: Map<string, ImplicitReference>,
  implicitReference: ImplicitReference | null,
): void {
  if (
    implicitReference === null ||
    referencesByTarget.has(implicitReference.targetConfigPath)
  ) {
    return;
  }

  referencesByTarget.set(implicitReference.targetConfigPath, implicitReference);
}

export function readImplicitReferences(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): { implicitRefs: ImplicitReference[]; problems: string[] } {
  const context: ImplicitReferenceContext = {
    config,
    problems: [],
    sourceConfigPath,
  };
  const result = resolveImplicitReferenceEntries(
    readJsonConfig(config, sourceConfigPath),
    context,
  );
  if (result.kind !== 'value') {
    return { implicitRefs: [], problems: context.problems };
  }

  const referencesByTarget = new Map<string, ImplicitReference>();
  for (const [index, entry] of result.entries.entries()) {
    addImplicitReferenceEntry(
      referencesByTarget,
      readImplicitReferenceEntry({ context, entry, index }),
    );
  }

  return {
    implicitRefs: referencesByTarget.values().toArray(),
    problems: context.problems,
  };
}
