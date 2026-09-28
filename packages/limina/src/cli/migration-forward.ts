import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getPrimaryCliCommandIndex } from './argv';

const pkg = createRequire(import.meta.url)('limina/package.json') as {
  version: string;
};

interface MigrationPackage {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}

export function migrationArguments(
  argv: readonly string[],
): string[] | undefined {
  const index = getPrimaryCliCommandIndex(argv);
  if (index === undefined) return undefined;
  if (argv[index] !== 'migration') return undefined;
  return [...argv.slice(2, index), ...argv.slice(index + 1)];
}

function resolveManifest(origin: string): string | undefined {
  try {
    return createRequire(origin).resolve('limina-migrate/package.json');
  } catch (error) {
    if (
      ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return undefined;
    throw error;
  }
}

function matchingBinary(manifest: MigrationPackage): string | undefined {
  if (manifest.name !== 'limina-migrate' || manifest.version !== pkg.version)
    return undefined;
  return packageBinary(manifest);
}

function packageBinary(manifest: MigrationPackage): string | undefined {
  const binary = manifest.bin?.['limina-migrate'];
  return typeof binary === 'string' ? binary : undefined;
}

function existingPath(candidate: string): string | undefined {
  return existsSync(candidate) ? candidate : undefined;
}

function localMigrationEntry(origin: string): string | undefined {
  const manifestPath = resolveManifest(origin);
  if (!manifestPath) return undefined;
  const binary = matchingBinary(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationPackage,
  );
  if (!binary) return undefined;
  return existingPath(path.resolve(path.dirname(manifestPath), binary));
}

function resolveLocalMigration(): string | undefined {
  const origins = [path.join(process.cwd(), 'package.json'), import.meta.url];
  for (const origin of origins) {
    const entry = localMigrationEntry(origin);
    if (entry) return entry;
  }
  return undefined;
}

function realLauncher(launcher: string): string[] {
  return existsSync(launcher) ? [realpathSync(launcher)] : [];
}

function directoryCandidates(directory: string): string[] {
  const launchers = ['npx', 'npx.cmd', 'npm', 'npm.cmd'].flatMap((name) =>
    realLauncher(path.join(directory, name)),
  );
  return [
    ...launchers,
    path.join(directory, 'node_modules/npm/bin/npx-cli.js'),
  ];
}

function npmCandidates(): string[] {
  const environmentPath =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === 'path',
    )?.[1] ?? '';
  const candidates = [process.env.npm_execpath].filter(
    (value): value is string => Boolean(value),
  );
  return [
    ...candidates,
    ...environmentPath
      .split(path.delimiter)
      .filter(Boolean)
      .flatMap(directoryCandidates),
  ];
}

function npxCandidate(candidate: string): string | undefined {
  const entry =
    path.basename(candidate) === 'npm-cli.js'
      ? path.join(path.dirname(candidate), 'npx-cli.js')
      : candidate;
  if (path.basename(entry) !== 'npx-cli.js') return undefined;
  return existingPath(entry);
}

function resolveNpxEntry(): string {
  for (const candidate of npmCandidates()) {
    const entry = npxCandidate(candidate);
    if (entry) return entry;
  }
  throw new Error(
    'Unable to resolve the npm JavaScript launcher. Install npm or install the matching limina-migrate locally.',
  );
}

function childArguments(args: string[]): string[] {
  const localEntry = resolveLocalMigration();
  return localEntry
    ? [localEntry, ...args]
    : [resolveNpxEntry(), '--yes', `limina-migrate@${pkg.version}`, ...args];
}

export async function forwardMigrationIfRequested(
  argv: readonly string[],
): Promise<boolean> {
  const args = migrationArguments(argv);
  if (!args) return false;
  if (args.some((arg) => ['--help', '-h'].includes(arg))) return false;
  await forwardMigration(args);
  return true;
}

async function runChild(args: string[]): Promise<void> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? 1;
    if (result.signal) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.kill(process.pid, result.signal);
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

export async function forwardMigration(args: string[]): Promise<void> {
  const command = `npx --yes limina-migrate@${pkg.version}`;
  process.stderr.write(
    `"limina migration" is deprecated. Use "${command}" instead.\n`,
  );
  try {
    await runChild(childArguments(args));
    if (process.exitCode)
      process.stderr.write(`Migration failed. Retry with ${command}.\n`);
  } catch (error) {
    throw new Error(`Unable to run migration. Run ${command} manually.`, {
      cause: error,
    });
  }
}
