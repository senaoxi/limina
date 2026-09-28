import process from 'node:process';

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

export function resolveColorEnabled(options: {
  env: NodeJS.ProcessEnv;
  isTTY: boolean | undefined;
}): boolean {
  const forceColor = options.env.FORCE_COLOR;

  if (forceColor !== undefined) {
    return forceColor !== '0';
  }

  if (options.env.NO_COLOR !== undefined) {
    return false;
  }

  return options.isTTY === true;
}

export function shouldUseColor(): boolean {
  return resolveColorEnabled({
    env: process.env,
    isTTY: process.stdout.isTTY,
  });
}
