import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Oxc 11 splits ? in a package-import key and conflates null with an inactive
// conditional target. Node also owns version/flag-dependent default conditions.
// Use Node for these compatibility cases and unresolved packages; resolve
// without loading the resource or recreating conditional exports rules.
const exactImportProbe = `
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { filePath, mode, specifier } = JSON.parse(process.argv[1]);
let resolved = null;
try {
  resolved = mode === 'require'
    ? createRequire(filePath).resolve(specifier)
    : fileURLToPath(import.meta.resolve(specifier));
} catch {}
process.stdout.write(JSON.stringify(resolved));
`;

export function resolveResourceWithNode(options: {
  conditions: readonly string[];
  filePath: string;
  mode: 'import' | 'require';
  preserveSymlinks: boolean;
  specifier: string;
}): string | null {
  const output = execFileSync(
    process.execPath,
    [
      ...process.execArgv.filter((argument) =>
        [
          '--no-addons',
          '--experimental-require-module',
          '--no-experimental-require-module',
        ].includes(argument),
      ),
      ...options.conditions.map((condition) => `--conditions=${condition}`),
      ...(options.preserveSymlinks ? ['--preserve-symlinks'] : []),
      '--input-type=module',
      '--eval',
      exactImportProbe,
      JSON.stringify(options),
    ],
    { cwd: path.dirname(options.filePath), encoding: 'utf8' },
  );
  return JSON.parse(output) as string | null;
}
