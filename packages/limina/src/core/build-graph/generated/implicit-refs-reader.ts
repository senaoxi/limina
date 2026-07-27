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
import type { ImplicitRef } from './config-reader-types';

interface ImplicitRefContext {
  config: ResolvedLiminaConfig;
  problems: string[];
  sourceConfigPath: string;
}

type ImplicitRefEntriesResult =
  | { kind: 'absent' | 'invalid' }
  | { entries: unknown[]; kind: 'value' };

interface RefTargetValidationOptions {
  sourceConfigPath: string;
  targetConfigPath: string;
}

type RefTargetValidator = (
  options: RefTargetValidationOptions,
) => string | null;

function getValueDetail(options: { value?: unknown }): string[] {
  return Object.hasOwn(options, 'value')
    ? [`  value: ${formatUnknownValue(options.value)}`]
    : [];
}

function addImplicitRefProblem(
  context: ImplicitRefContext,
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

function resolveImplicitRefEntries(
  configObject: Record<string, unknown>,
  context: ImplicitRefContext,
): ImplicitRefEntriesResult {
  const liminaOptions = configObject.liminaOptions;
  if (liminaOptions === undefined) {
    return { kind: 'absent' };
  }

  if (!isPlainRecord(liminaOptions)) {
    addImplicitRefProblem(context, {
      field: 'liminaOptions',
      reason:
        'liminaOptions must be an object before implicitRefs can be read.',
      value: liminaOptions,
    });
    return { kind: 'invalid' };
  }

  return resolveImplicitRefArray(liminaOptions.implicitRefs, context);
}

function resolveImplicitRefArray(
  value: unknown,
  context: ImplicitRefContext,
): ImplicitRefEntriesResult {
  if (value === undefined) {
    return { kind: 'absent' };
  }

  if (Array.isArray(value)) {
    return { entries: value, kind: 'value' };
  }

  addImplicitRefProblem(context, {
    field: 'liminaOptions.implicitRefs',
    reason:
      'implicitRefs must be an array of objects with non-empty path and reason fields.',
    value,
  });
  return { kind: 'invalid' };
}

function readRequiredString(options: {
  context: ImplicitRefContext;
  field: string;
  reason: string;
  value: unknown;
}): string | null {
  if (isNonEmptyString(options.value)) {
    return options.value.trim();
  }

  addImplicitRefProblem(options.context, {
    field: options.field,
    reason: options.reason,
    value: options.value,
  });
  return null;
}

const validateNotSelfReference: RefTargetValidator = (options) =>
  options.targetConfigPath === options.sourceConfigPath
    ? 'implicitRefs must not reference the declaring tsconfig.'
    : null;

const validateExistingTarget: RefTargetValidator = (options) =>
  existsSync(options.targetConfigPath)
    ? null
    : 'implicitRefs path must point to an existing ordinary source tsconfig.';

const validateOrdinarySourceTarget: RefTargetValidator = (options) =>
  isOrdinarySourceTypecheckConfigPath(options.targetConfigPath)
    ? null
    : 'implicitRefs path must point to an ordinary source tsconfig*.json file, not a generated, declaration, build, base, or check config.';

const targetValidators: readonly RefTargetValidator[] = [
  validateNotSelfReference,
  validateExistingTarget,
  validateOrdinarySourceTarget,
];

function findTargetProblem(options: RefTargetValidationOptions): string | null {
  for (const validate of targetValidators) {
    const problem = validate(options);
    if (problem !== null) {
      return problem;
    }
  }

  return null;
}

function validateRelativeRefPath(options: {
  context: ImplicitRefContext;
  field: string;
  pathValue: string;
}): boolean {
  if (!path.isAbsolute(options.pathValue)) {
    return true;
  }

  addImplicitRefProblem(options.context, {
    field: options.field,
    reason:
      'implicitRefs path must be relative to the tsconfig that declares it.',
    value: options.pathValue,
  });
  return false;
}

function createValidatedImplicitRef(options: {
  context: ImplicitRefContext;
  field: string;
  pathValue: string;
  reasonValue: string;
}): ImplicitRef | null {
  if (!validateRelativeRefPath(options)) {
    return null;
  }

  const targetConfigPath = resolveReferencePath(
    options.context.sourceConfigPath,
    options.pathValue,
  );
  const problem = findTargetProblem({
    sourceConfigPath: options.context.sourceConfigPath,
    targetConfigPath,
  });
  if (problem !== null) {
    addImplicitRefProblem(options.context, {
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

function readImplicitRefEntry(options: {
  context: ImplicitRefContext;
  entry: unknown;
  index: number;
}): ImplicitRef | null {
  const field = `liminaOptions.implicitRefs[${options.index}]`;
  if (!isPlainRecord(options.entry)) {
    addImplicitRefProblem(options.context, {
      field,
      reason:
        'implicitRefs entries must be objects with non-empty path and reason fields.',
      value: options.entry,
    });
    return null;
  }

  return readImplicitRefRecord({
    context: options.context,
    entry: options.entry,
    field,
  });
}

function readImplicitRefRecord(options: {
  context: ImplicitRefContext;
  entry: Record<string, unknown>;
  field: string;
}): ImplicitRef | null {
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

  return createValidatedImplicitRef({
    context: options.context,
    field: options.field,
    pathValue,
    reasonValue,
  });
}

function addImplicitRefEntry(
  refsByTarget: Map<string, ImplicitRef>,
  implicitRef: ImplicitRef | null,
): void {
  if (implicitRef === null || refsByTarget.has(implicitRef.targetConfigPath)) {
    return;
  }

  refsByTarget.set(implicitRef.targetConfigPath, implicitRef);
}

export function readImplicitRefs(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): { implicitRefs: ImplicitRef[]; problems: string[] } {
  const context: ImplicitRefContext = {
    config,
    problems: [],
    sourceConfigPath,
  };
  const result = resolveImplicitRefEntries(
    readJsonConfig(config, sourceConfigPath),
    context,
  );
  if (result.kind !== 'value') {
    return { implicitRefs: [], problems: context.problems };
  }

  const refsByTarget = new Map<string, ImplicitRef>();
  for (const [index, entry] of result.entries.entries()) {
    addImplicitRefEntry(
      refsByTarget,
      readImplicitRefEntry({ context, entry, index }),
    );
  }

  return {
    implicitRefs: [...refsByTarget.values()],
    problems: context.problems,
  };
}
