import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';

export interface InternalProcessEntry {
  args: string[];
  command: string;
}

function resolveTsxCliPath(
  moduleUrl: string,
  packageDir: string,
): string | null {
  try {
    return createRequire(moduleUrl).resolve('tsx/cli');
  } catch {
    return (
      [
        path.join(packageDir, 'node_modules/tsx/dist/cli.mjs'),
        path.join(packageDir, '../../node_modules/tsx/dist/cli.mjs'),
      ].find((candidate) => existsSync(candidate)) ?? null
    );
  }
}

function createProcessEntry(entryPath: string): InternalProcessEntry {
  return {
    args: [entryPath],
    command: process.execPath,
  };
}

function resolveSourceProcessEntry(options: {
  moduleUrl: string;
  sourceEntry: string;
}): InternalProcessEntry | undefined {
  if (!existsSync(options.sourceEntry)) {
    return undefined;
  }

  const packageDir = path.resolve(path.dirname(options.sourceEntry), '../..');
  const tsxCliPath = resolveTsxCliPath(options.moduleUrl, packageDir);
  return tsxCliPath === null
    ? undefined
    : {
        args: [tsxCliPath, options.sourceEntry],
        command: process.execPath,
      };
}

function resolveBundleProcessEntry(
  currentDir: string,
  bundleFileName: string,
): InternalProcessEntry | undefined {
  const bundleEntry = [
    path.resolve(currentDir, bundleFileName),
    path.resolve(currentDir, '..', bundleFileName),
  ].find((candidate) => existsSync(candidate));

  return bundleEntry === undefined
    ? undefined
    : createProcessEntry(bundleEntry);
}

export function resolveInternalProcessEntry(options: {
  bundleFileName: string;
  moduleUrl: string;
  sourceFileName: string;
}): InternalProcessEntry | undefined {
  const currentDir = fileURLToPath(new URL('.', options.moduleUrl));
  const sourceEntry = path.resolve(currentDir, options.sourceFileName);
  const sourceProcessEntry = resolveSourceProcessEntry({
    moduleUrl: options.moduleUrl,
    sourceEntry,
  });

  return (
    sourceProcessEntry ??
    resolveBundleProcessEntry(currentDir, options.bundleFileName)
  );
}
