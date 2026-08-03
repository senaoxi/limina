const ENABLED_CI_VALUES = new Set(['1', 'true']);

function isEnabledEnvironmentValue(value: string | undefined): boolean {
  return ENABLED_CI_VALUES.has(String(value).toLowerCase());
}

export function isCapturedTerminalEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    isEnabledEnvironmentValue(env.CI) || isEnabledEnvironmentValue(env.CODEX_CI)
  );
}

export function supportsInteractiveTerminal(
  env: NodeJS.ProcessEnv,
  stdout: { isTTY?: boolean },
): boolean {
  if (!stdout.isTTY) {
    return false;
  }

  if (isCapturedTerminalEnvironment(env)) {
    return false;
  }

  return String(env.TERM).toLowerCase() !== 'dumb';
}
