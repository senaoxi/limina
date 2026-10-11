import { isPlainConfigRecord } from './shared';

const removedImportAnalysisReason =
  'config.imports.vue was removed in the Vue semantic architecture release. Delete config.imports.vue; there is no replacement field.';

const movedFields: Readonly<Record<string, string>> = {
  config: 'scope',
  regions: 'scope.regions',
};

function executionFieldTarget(key: string): string {
  return key === 'pipelines' || key === 'concurrency'
    ? key
    : `concurrency.${key}`;
}

function executionProblems(value: unknown): string[] {
  const fields = isPlainConfigRecord(value)
    ? Object.getOwnPropertyNames(value)
    : [];
  return fields.length === 0
    ? [
        'execution has moved to concurrency. Configure pipelines at the top level.',
      ]
    : fields.map(
        (key) => `execution.${key} has moved to ${executionFieldTarget(key)}.`,
      );
}

const removedGroups: Readonly<Record<string, (value: unknown) => string[]>> = {
  checks: () => [
    'checks is not supported. Configure graph, source, proof, package, and release at the top level.',
  ],
  execution: executionProblems,
};

function movedFieldMessage(from: string, to: string, field: string): string {
  return from === 'config' && field === 'imports'
    ? removedImportAnalysisReason
    : `${from}.${field} has moved to ${to}.${field}.`;
}

function movedFieldProblems(
  from: string,
  to: string,
  value: unknown,
): string[] {
  const fields = isPlainConfigRecord(value)
    ? Object.getOwnPropertyNames(value)
    : [];
  return fields.length === 0
    ? [`${from} has moved to ${to}.`]
    : fields.map((field) => movedFieldMessage(from, to, field));
}

function rootFieldProblems(
  value: Record<string, unknown>,
  key: string,
): string[] {
  if (Object.hasOwn(removedGroups, key)) return removedGroups[key]!(value[key]);
  return Object.hasOwn(movedFields, key)
    ? movedFieldProblems(key, movedFields[key]!, value[key])
    : [];
}

/**
Reject legacy keys even when hidden or explicitly undefined; never translate them.
*/
export function legacyConfigProblems(value: unknown): string[] {
  return isPlainConfigRecord(value)
    ? Object.getOwnPropertyNames(value).flatMap((key) =>
        rootFieldProblems(value, key),
      )
    : [];
}
