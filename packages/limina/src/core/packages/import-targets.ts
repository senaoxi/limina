import { isPlainRecord } from '#utils/values';

function getConditionalTargets(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  return isPlainRecord(value) ? Object.values(value) : null;
}

function collectConditionalTargets(value: unknown, targets: unknown[]): void {
  const nestedTargets = getConditionalTargets(value);

  if (nestedTargets === null) {
    targets.push(value);
    return;
  }

  for (const target of nestedTargets) {
    collectConditionalTargets(target, targets);
  }
}

function replaceWildcardTarget(
  target: unknown,
  wildcardValue: string | null,
): unknown {
  return typeof target === 'string' && wildcardValue !== null
    ? target.replaceAll('*', () => wildcardValue)
    : target;
}

export function expandPackageImportTargets(
  value: unknown,
  key: string,
  specifier: string,
): unknown[] {
  const index = key.indexOf('*');
  const wildcard =
    index === -1
      ? null
      : specifier.slice(index, specifier.length - (key.length - index - 1));
  const targets: unknown[] = [];
  collectConditionalTargets(value, targets);
  return targets.map((target) => replaceWildcardTarget(target, wildcard));
}
