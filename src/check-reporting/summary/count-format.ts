const CHECK_COUNT_UNITS = ['', 'K', 'M', 'B', 'T', 'P', 'E'] as const;

function trimTrailingZeroes(value: string): string {
  if (!value.includes('.')) return value;
  const withoutZeroes = value.replace(/0+$/u, '');
  if (!withoutZeroes.endsWith('.')) return withoutZeroes;
  return withoutZeroes.slice(0, -1);
}

function scaleCheckCount(value: number): { scaled: number; unitIndex: number } {
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1000 && unitIndex < CHECK_COUNT_UNITS.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  return { scaled, unitIndex };
}

function isFinalUnit(unitIndex: number): boolean {
  return unitIndex === CHECK_COUNT_UNITS.length - 1;
}

function formatCurrentUnit(
  rounded: number,
  precision: number,
  unitIndex: number,
): string {
  const formatted = trimTrailingZeroes(rounded.toFixed(precision));
  return `${formatted}${CHECK_COUNT_UNITS[unitIndex]}`;
}

function formatPromotedUnit(rounded: number, unitIndex: number): string {
  const promoted = trimTrailingZeroes((rounded / 1000).toFixed(1));
  return `${promoted}${CHECK_COUNT_UNITS[unitIndex + 1]}`;
}

function shouldUseCurrentUnit(rounded: number, unitIndex: number): boolean {
  if (rounded < 1000) return true;
  return isFinalUnit(unitIndex);
}

function formatScaledCount(scaled: number, unitIndex: number): string {
  const precision = scaled >= 100 ? 0 : 1;
  const rounded = Number(scaled.toFixed(precision));
  if (shouldUseCurrentUnit(rounded, unitIndex)) {
    return formatCurrentUnit(rounded, precision, unitIndex);
  }
  return formatPromotedUnit(rounded, unitIndex);
}

export function formatCheckCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  const scaled = scaleCheckCount(value);
  return formatScaledCount(scaled.scaled, scaled.unitIndex);
}
