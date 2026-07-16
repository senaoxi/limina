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

export function resolveInternalProcessEntry(options: {
  bundleFileName: string;
  moduleUrl: string;
  sourceFileName: string;
}): InternalProcessEntry | undefined {
  const currentDir = fileURLToPath(new URL('.', options.moduleUrl));
  const sourceEntry = path.resolve(currentDir, options.sourceFileName);

  if (existsSync(sourceEntry)) {
    const packageDir = path.resolve(path.dirname(sourceEntry), '../..');
    const tsxCliPath = resolveTsxCliPath(options.moduleUrl, packageDir);

    if (!tsxCliPath) {
      return undefined;
    }

    return {
      args: [tsxCliPath, sourceEntry],
      command: process.execPath,
    };
  }

  const bundleEntry = [
    path.resolve(currentDir, options.bundleFileName),
    path.resolve(currentDir, '..', options.bundleFileName),
  ].find((candidate) => existsSync(candidate));

  if (!bundleEntry) {
    return undefined;
  }

  return {
    args: [bundleEntry],
    command: process.execPath,
  };
}
