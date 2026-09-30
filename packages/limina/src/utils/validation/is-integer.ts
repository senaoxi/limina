function isUnsafeInteger(value: number): boolean {
  // Every finite double outside the safe range already has integral spacing.
  return Number.isFinite(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER;
}

/**
Preserve contracts that accept every representable integer, including unsafe integers.
*/
export function isIntegerNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    (Number.isSafeInteger(value) || isUnsafeInteger(value))
  );
}

export function parseIntegerPrefix(value: string): number {
  return Number(/^\s*[+-]?\d+/u.exec(value)?.[0] ?? NaN);
}
