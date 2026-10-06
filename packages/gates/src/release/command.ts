import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleaseCommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  platform: NodeJS.Platform;
}

function resolveNpmEntry(context: ReleaseCommandContext): string {
  const npmExecPath = context.env.npm_execpath;
  if (
    npmExecPath &&
    path.basename(npmExecPath).toLowerCase() === 'npm-cli.js' &&
    existsSync(npmExecPath)
  ) {
    return npmExecPath;
  }

  // Match Node's case-insensitive, lexicographically selected Windows PATH.
  let pathKey: string | undefined;
  for (const key of Object.keys(context.env)) {
    if (key.toLowerCase() === 'path' && (!pathKey || key < pathKey)) {
      pathKey = key;
    }
  }
  const directories = (pathKey ? (context.env[pathKey] ?? '') : '').split(';');
  for (const value of directories) {
    if (!value) continue;
    const directory =
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    const shim = path.resolve(context.cwd, directory, 'npm.cmd');
    if (!existsSync(shim)) continue;
    const entry = path.join(
      path.dirname(realpathSync(shim)),
      'node_modules/npm/bin/npm-cli.js',
    );
    if (existsSync(entry)) return entry;
    throw new Error(`Cannot resolve the npm JavaScript entry beside ${shim}.`);
  }

  const bundledEntry = path.join(
    path.dirname(context.execPath),
    'node_modules/npm/bin/npm-cli.js',
  );
  if (existsSync(bundledEntry)) return bundledEntry;
  throw new Error('Cannot resolve the npm JavaScript entry for Windows.');
}

export function resolveReleaseCommand(
  command: string,
  arguments_: string[],
  context: ReleaseCommandContext,
): { command: string; arguments: string[] } {
  if (context.platform !== 'win32' || !/^npm(?:\.cmd)?$/iu.test(command)) {
    return { command, arguments: arguments_ };
  }
  return {
    command: context.execPath,
    arguments: [resolveNpmEntry(context), ...arguments_],
  };
}

export function execReleaseCommand(
  command: string,
  arguments_: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveReleaseCommand(command, arguments_, {
    cwd: typeof cwd === 'string' ? cwd : fileURLToPath(cwd),
    env: options.env ?? process.env,
    execPath: process.execPath,
    platform: process.platform,
  });
  return execFileSync(resolved.command, resolved.arguments, {
    ...options,
    shell: false,
  });
}
