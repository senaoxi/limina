export type ShellCommandDialect = 'posix' | 'powershell';

const SAFE_SHELL_TOKEN = /^[\w@%+=:,./-]+$/u;

export function getHostShellCommandDialect(
  platform: NodeJS.Platform = process.platform,
): ShellCommandDialect {
  return platform === 'win32' ? 'powershell' : 'posix';
}

function quotePosixToken(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellToken(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteShellCommandToken(
  value: string,
  dialect: ShellCommandDialect,
): string {
  if (value.length > 0 && SAFE_SHELL_TOKEN.test(value)) {
    return value;
  }

  return dialect === 'powershell'
    ? quotePowerShellToken(value)
    : quotePosixToken(value);
}

export function formatShellCommand(
  tokens: readonly string[],
  dialect: ShellCommandDialect = getHostShellCommandDialect(),
): string {
  return tokens
    .map((token) => quoteShellCommandToken(token, dialect))
    .join(' ');
}
