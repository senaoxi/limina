export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringifyUnknownValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function formatUnknownValue(value: unknown): string {
  return stringifyUnknownValue(value) ?? String(value);
}
