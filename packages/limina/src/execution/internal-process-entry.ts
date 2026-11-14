import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'pathe';

export interface InternalProcessEntry {
  args: string[];
  command: string;
}

function resolveTsxCliPath(
  moduleUrl: string,
  packageDirectory: string,
): string | null {
  try {
    return createRequire(moduleUrl).resolve('tsx/cli');
  } catch {
    return (
      [
        path.join(packageDirectory, 'node_modules/tsx/dist/cli.mjs'),
        path.join(packageDirectory, '../../node_modules/tsx/dist/cli.mjs'),
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
  sourceLoader?: 'direct';
}): InternalProcessEntry | undefined {
  if (!existsSync(options.sourceEntry)) {
    return undefined;
  }

  if (options.sourceLoader === 'direct') {
    try {
      const loader = createRequire(options.moduleUrl).resolve('tsx');
      return {
        command: process.execPath,
        args: ['--import', pathToFileURL(loader).href, options.sourceEntry],
      };
    } catch {
      return undefined;
    }
  }

  const packageDirectory = path.resolve(
    path.dirname(options.sourceEntry),
    '../..',
  );
  const tsxCliPath = resolveTsxCliPath(options.moduleUrl, packageDirectory);
  return tsxCliPath === null
    ? undefined
    : {
        args: [tsxCliPath, options.sourceEntry],
        command: process.execPath,
      };
}

function resolveBundleProcessEntry(
  currentDirectory: string,
  bundleFileName: string,
): InternalProcessEntry | undefined {
  const bundleEntry = [
    path.resolve(currentDirectory, bundleFileName),
    path.resolve(currentDirectory, '..', bundleFileName),
  ].find((candidate) => existsSync(candidate));

  return bundleEntry === undefined
    ? undefined
    : createProcessEntry(bundleEntry);
}

export function resolveInternalProcessEntry(options: {
  bundleFileName: string;
  moduleUrl: string;
  sourceFileName: string;
  sourceLoader?: 'direct';
}): InternalProcessEntry | undefined {
  const currentDirectory = fileURLToPath(new URL('.', options.moduleUrl));
  const sourceEntry = path.resolve(currentDirectory, options.sourceFileName);
  const sourceProcessEntry = resolveSourceProcessEntry({
    moduleUrl: options.moduleUrl,
    sourceEntry,
    sourceLoader: options.sourceLoader,
  });

  return (
    sourceProcessEntry ??
    resolveBundleProcessEntry(currentDirectory, options.bundleFileName)
  );
}
