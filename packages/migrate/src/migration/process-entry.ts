import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';

export function resolveMigrationProcessEntry(options: {
  moduleUrl: string;
  sourceFileName: string;
  bundleFileName: string;
}): { command: string; args: string[] } | undefined {
  const require = createRequire(import.meta.url);
  const packageDirectory = path.dirname(
    require.resolve('limina-migrate/package.json'),
  );
  const sourceEntry = fileURLToPath(
    new URL(options.sourceFileName, options.moduleUrl),
  );
  if (existsSync(sourceEntry)) {
    return {
      command: process.execPath,
      args: [
        require.resolve('tsx/cli'),
        '--conditions=development',
        sourceEntry,
      ],
    };
  }
  const bundleEntry = path.join(packageDirectory, options.bundleFileName);
  return existsSync(bundleEntry)
    ? { command: process.execPath, args: [bundleEntry] }
    : undefined;
}
