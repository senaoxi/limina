const ENABLED_CI_VALUES = new Set(['1', 'true']);

function isEnabledEnvironmentValue(value: string | undefined): boolean {
  return ENABLED_CI_VALUES.has(String(value).toLowerCase());
}

export function isCapturedTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    isEnabledEnvironmentValue(environment.CI) ||
    isEnabledEnvironmentValue(environment.CODEX_CI)
  );
}

export function isSupportsInteractiveTerminal(
  environment: NodeJS.ProcessEnv,
  stdout: { isTTY?: boolean },
): boolean {
  return (
    !(!stdout.isTTY || isCapturedTerminalEnvironment(environment)) &&
    String(environment.TERM).toLowerCase() !== 'dumb'
  );
}
