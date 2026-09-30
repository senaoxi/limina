import process from 'node:process';

const ANSI_RESET = '\u{1B}[0m';

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

export function isResolveColorEnabled(options: {
  env: NodeJS.ProcessEnv;
  isTTY: boolean | undefined;
}): boolean {
  const forceColor = options.env.FORCE_COLOR;

  return forceColor === undefined
    ? options.env.NO_COLOR === undefined && options.isTTY === true
    : forceColor !== '0';
}

export function shouldUseColor(): boolean {
  return isResolveColorEnabled({
    env: process.env,
    isTTY: process.stdout.isTTY,
  });
}
