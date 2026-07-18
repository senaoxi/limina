const ANSI_RESET = '\u001B[0m';

export function plural(
  count: number,
  singular: string,
  pluralForm: string,
): string {
  return count === 1 ? singular : pluralForm;
}

export function colorText(color: string, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}
