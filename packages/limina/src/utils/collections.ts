export function uniqueValues<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function countDefinedBy<T>(
  values: Iterable<T>,
  getKey: (value: T) => string | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = getKey(value);

    if (!key) {
      continue;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

export function uniqueSortedStrings(values: Iterable<string>): string[] {
  return uniqueValues(values).sort((left, right) => left.localeCompare(right));
}

export function uniqueTrimmedNonEmptySortedStrings(
  values: Iterable<string | null | undefined>,
): string[] {
  return uniqueSortedStrings(
    [...values]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}
