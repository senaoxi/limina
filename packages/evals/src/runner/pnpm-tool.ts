import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
The dependency closure is already admitted; run/exec must never reinstall it.
*/
export function pnpmRuntimeArguments(
  commandArguments: readonly string[],
): string[] {
  return [
    'with',
    'current',
    '--config.verify-deps-before-run=false',
    '--config.ignore-scripts=true',
    '--config.offline=true',
    ...commandArguments,
  ];
}

/**
Shared by native task tools and offline review. This prevents accidental package
installation through PATH; the underlying binary remains readable for execution.
*/
export function renderPnpmTool(node: string, pnpm: string): string {
  if (
    !path.isAbsolute(node) ||
    /[\r\n\0]/.test(node) ||
    !path.isAbsolute(pnpm) ||
    pnpm.includes('\0')
  )
    throw new Error('PNPM tool requires absolute pinned executable paths');
  const quotedNode = `'${node.replaceAll("'", String.raw`'\''`)}'`;
  return String.raw`#!/bin/sh
':' //; exec ${quotedNode} "$0" "$@"
const { spawnSync } = process.getBuiltinModule('node:child_process');
let args = process.argv.slice(2);
while (args[0] === 'with' && args[1] === 'current') args = args.slice(2);
const forbidden = new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'ln', 'unlink', 'dlx', 'fetch', 'import', 'rebuild', 'setup', 'deploy', 'dedupe', 'patch', 'patch-commit', 'patch-remove', 'store', 'env', 'self-update', 'with']);
const valuedOptions = new Set(['--dir', '-C', '--filter', '-F', '--filter-prod', '--workspace-dir', '--config-dir']);
const options = [];
let index = 0;
for (; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--' || !argument.startsWith('-')) break;
  if (/^--(?:config\.)?(?:verify-deps-before-run|ignore-scripts|offline)(?:=|$)/.test(argument)) {
    if (!argument.includes('=') && /^(?:true|false)$/.test(args[index + 1] || '')) index++;
    continue;
  }
  if (/^--no-(?:verify-deps-before-run|ignore-scripts|offline)$/.test(argument)) continue;
  options.push(argument);
  if (valuedOptions.has(argument) && index + 1 < args.length) options.push(args[++index]);
}
const command = args[index] === '--' ? args[index + 1] : args[index];
if (forbidden.has(command)) {
  process.stderr.write('LIMINA_EVAL_PNPM_INSTALL_FORBIDDEN\n');
  process.exit(80);
}
const result = spawnSync(${JSON.stringify(pnpm)}, [...${JSON.stringify(pnpmRuntimeArguments([]))}, ...options, ...args.slice(index)], {
  stdio: 'inherit',
  env: { ...process.env, npm_config_verify_deps_before_run: 'false', npm_config_ignore_scripts: 'true', npm_config_offline: 'true' },
});
if (result.error) process.stderr.write(String(result.error) + '\n');
process.exit(result.status ?? 81);
`;
}

function assertRealDirectory(directory: string): void {
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('PNPM tool ancestor must be a real directory');
    if (path.dirname(current) === current) return;
  }
}

/**
Prepare only excluded runtime state, never overwrite an existing tool.
*/
export function preparePnpmTool(
  workspace: string,
  node: string,
  pnpm: string,
): string {
  if (!path.isAbsolute(workspace) || path.resolve(workspace) !== workspace)
    throw new Error('PNPM tool needs a canonical absolute workspace');
  const source = renderPnpmTool(node, pnpm);
  assertRealDirectory(workspace);
  let directory = workspace;
  for (const part of ['.eval-tmp', 'limina-tools']) {
    directory = path.join(directory, part);
    try {
      mkdirSync(directory, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    assertRealDirectory(directory);
  }
  const executable = path.join(directory, 'pnpm');
  try {
    writeFileSync(executable, source, { flag: 'wx', mode: 0o555 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = lstatSync(executable);
  if (!existing.isFile() || (existing.mode & 0o777) !== 0o555)
    throw new Error('PNPM tool differs from the frozen read-only template');
  const handle = openSync(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(handle);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o555 ||
      stat.dev !== existing.dev ||
      stat.ino !== existing.ino ||
      readFileSync(handle, 'utf8') !== source
    )
      throw new Error('PNPM tool differs from the frozen read-only template');
  } finally {
    closeSync(handle);
  }
  assertRealDirectory(directory);
  return directory;
}
