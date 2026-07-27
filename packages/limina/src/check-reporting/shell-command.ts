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

function isSafeShellToken(value: string): boolean {
  return value.length > 0 && SAFE_SHELL_TOKEN.test(value);
}

function quoteUnsafeShellToken(
  value: string,
  dialect: ShellCommandDialect,
): string {
  return dialect === 'powershell'
    ? quotePowerShellToken(value)
    : quotePosixToken(value);
}

export function quoteShellCommandToken(
  value: string,
  dialect: ShellCommandDialect,
): string {
  return isSafeShellToken(value)
    ? value
    : quoteUnsafeShellToken(value, dialect);
}

export function formatShellCommand(
  tokens: readonly string[],
  dialect: ShellCommandDialect = getHostShellCommandDialect(),
): string {
  return tokens
    .map((token) => quoteShellCommandToken(token, dialect))
    .join(' ');
}
