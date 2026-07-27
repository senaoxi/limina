export function appendOptionalField(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (value !== undefined) lines.push(`${label}: ${value}`);
}

export function appendOptionalSection(
  lines: string[],
  section: readonly string[],
): void {
  if (section.length > 0) lines.push('', ...section);
}
