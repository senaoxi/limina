import nodePath from 'node:path';

function getPathEnvValue(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PATH !== undefined) {
    return env.PATH;
  }

  if (env.Path !== undefined) {
    return env.Path;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');

  return pathKey ? env[pathKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') {
    return 'PATH';
  }

  return Object.keys(env).find((key) => key === 'Path') ?? 'Path';
}

export function prependPathEntry(
  env: NodeJS.ProcessEnv,
  entry: string,
): NodeJS.ProcessEnv {
  const pathKey = getPathEnvKey(env);
  const currentPath = getPathEnvValue(env);
  const nextEnv = { ...env };

  if (process.platform === 'win32') {
    for (const key of Object.keys(nextEnv)) {
      if (key !== pathKey && key.toLowerCase() === 'path') {
        delete nextEnv[key];
      }
    }
  }

  nextEnv[pathKey] = [entry, currentPath]
    .filter(Boolean)
    .join(nodePath.delimiter);

  return nextEnv;
}

export function shouldUseShellForCommand(command: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const extension = nodePath.extname(command).toLowerCase();

  return (
    !nodePath.isAbsolute(command) ||
    extension === '.bat' ||
    extension === '.cmd'
  );
}
