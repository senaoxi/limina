import nodePath from 'node:path';

function findPathEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path');
}

function getPathEnvValue(env: NodeJS.ProcessEnv): string | undefined {
  const pathKey = findPathEnvKey(env);

  return pathKey ? env[pathKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') {
    return 'PATH';
  }

  return Object.keys(env).find((key) => key === 'Path') ?? 'Path';
}

function isDuplicatePathKey(key: string, pathKey: string): boolean {
  return key !== pathKey && key.toLowerCase() === 'path';
}

function removeDuplicateWindowsPathKeys(
  env: NodeJS.ProcessEnv,
  pathKey: string,
): void {
  if (process.platform !== 'win32') {
    return;
  }

  for (const key of Object.keys(env).filter((candidate) =>
    isDuplicatePathKey(candidate, pathKey),
  )) {
    delete env[key];
  }
}

export function prependPathEntry(
  env: NodeJS.ProcessEnv,
  entry: string,
): NodeJS.ProcessEnv {
  const pathKey = getPathEnvKey(env);
  const nextEnv = { ...env };

  removeDuplicateWindowsPathKeys(nextEnv, pathKey);
  nextEnv[pathKey] = [entry, getPathEnvValue(env)]
    .filter(Boolean)
    .join(nodePath.delimiter);

  return nextEnv;
}

function isWindowsShellCommand(command: string): boolean {
  const extension = nodePath.extname(command).toLowerCase();

  return (
    !nodePath.isAbsolute(command) ||
    extension === '.bat' ||
    extension === '.cmd'
  );
}

export function shouldUseShellForCommand(command: string): boolean {
  return process.platform === 'win32' && isWindowsShellCommand(command);
}
