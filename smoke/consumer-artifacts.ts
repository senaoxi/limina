import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_FIXTURE_PACKAGE_NAME = '@limina-smoke/release-fixture';

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeConsumerArtifacts(
  fixtureDirectory: string,
): Promise<void> {
  await mkdir(path.join(fixtureDirectory, 'release-dist'), { recursive: true });
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'package.json'),
    stringifyJson({
      exports: {
        '.': './index.js',
      },
      license: 'MIT',
      name: RELEASE_FIXTURE_PACKAGE_NAME,
      type: 'module',
      types: './index.d.ts',
      version: '1.0.0',
    }),
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'index.js'),
    'export const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'index.d.ts'),
    'export declare const value = 1;\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'README.md'),
    '# Release fixture\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'release-dist', 'LICENSE.md'),
    'MIT\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureDirectory, 'verify-exports.mjs'),
    `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicApi = await import('limina');
const schemaPath = fileURLToPath(import.meta.resolve('limina/schemas/tsconfig-schema.json'));
const packageJsonPath = fileURLToPath(import.meta.resolve('limina/package.json'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

if (typeof publicApi.defineConfig !== 'function') {
  throw new Error('limina root export did not expose defineConfig.');
}
for (const removedExport of [
  'loadConfig',
  'runGraphCheck',
  'runSourceCheck',
  'prepareGeneratedTsconfigGraph',
  'collectDependencyGraph',
  'createLiminaFlowReporter',
]) {
  if (removedExport in publicApi) {
    throw new Error(\`limina root export should not expose \${removedExport}.\`);
  }
}
let configExportRejected = false;
try {
  await import('limina/config');
} catch (error) {
  configExportRejected =
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}
if (!configExportRejected) {
  throw new Error('limina/config export should not be exposed.');
}
if (Object.keys(manifest.exports ?? {}).some(key => key === './internal' || key.startsWith('./internal/'))) {
  throw new Error('Published Limina must not expose workspace-only internal modules.');
}
for (const specifier of [
  'limina/internal/core/tsconfig/actions',
  'limina/internal/config/runner',
  'limina/internal/logger',
]) {
  let rejected = false;
  try {
    await import(specifier);
  } catch (error) {
    rejected = Boolean(error) && typeof error === 'object' && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  }
  if (!rejected) throw new Error(\`Published Limina must reject \${specifier}.\`);
}
if (manifest.name !== 'limina') {
  throw new Error('limina/package.json did not resolve to the installed package.');
}
if (!schema || typeof schema !== 'object') {
  throw new Error('limina schema export did not resolve to JSON content.');
}
try {
  import.meta.resolve('svelte2tsx');
  throw new Error('The non-Svelte consumer unexpectedly installed svelte2tsx.');
} catch (error) {
  if (error instanceof Error && error.message.includes('unexpectedly installed')) {
    throw error;
  }
}

console.log('limina exports ok');
`,
    'utf8',
  );
}
