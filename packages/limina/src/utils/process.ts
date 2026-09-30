import nodePath from 'node:path';

function findPathEnvironmentKey(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return Object.keys(environment).find((key) => key.toLowerCase() === 'path');
}

function getPathEnvironmentValue(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const pathKey = findPathEnvironmentKey(environment);

  return pathKey ? environment[pathKey] : undefined;
}

function getPathEnvironmentKey(environment: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? (Object.keys(environment).find((key) => key === 'Path') ?? 'Path')
    : 'PATH';
}

function isDuplicatePathKey(key: string, pathKey: string): boolean {
  return key !== pathKey && key.toLowerCase() === 'path';
}

function removeDuplicateWindowsPathKeys(
  environment: NodeJS.ProcessEnv,
  pathKey: string,
): void {
  if (process.platform !== 'win32') {
    return;
  }

  const duplicateKeys = Object.keys(environment).filter((key) =>
    isDuplicatePathKey(key, pathKey),
  );
  for (const key of duplicateKeys) {
    delete environment[key];
  }
}

export function prependPathEntry(
  environment: NodeJS.ProcessEnv,
  entry: string,
): NodeJS.ProcessEnv {
  const pathKey = getPathEnvironmentKey(environment);
  const nextEnvironment = { ...environment };

  removeDuplicateWindowsPathKeys(nextEnvironment, pathKey);
  nextEnvironment[pathKey] = [entry, getPathEnvironmentValue(environment)]
    .filter(Boolean)
    .join(nodePath.delimiter);

  return nextEnvironment;
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
