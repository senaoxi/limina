import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const peerToolsUrl = new URL('../package-check/peer-tools.ts', import.meta.url)
  .href;
const hook = `
let packageName, parentURL;
export function initialize(data) { ({ packageName, parentURL } = data); }
export function resolve(specifier, context, nextResolve) {
  if (specifier === packageName || specifier.startsWith(packageName + '/')) {
    return nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
}
`;
const worker = `
import { register } from 'node:module';
const [packageName, toolsUrl, loaderName] = process.argv.slice(2);
register(new URL('./hook.mjs', import.meta.url), { parentURL: import.meta.url, data: { packageName, parentURL: import.meta.url } });
const tools = await import(toolsUrl);
try { await tools[loaderName](); console.log(JSON.stringify({ status: 'loaded' })); }
catch (error) { console.log(JSON.stringify({ status: 'error', name: error.name, code: error.code, message: error.message })); }
`;

type Mode =
  | 'healthy'
  | 'missing'
  | 'initializer'
  | 'syntax'
  | 'transitive'
  | 'entry'
  | 'hidden-metadata'
  | 'conditions';

function peerFiles(packageName: string, mode: Mode): Record<string, string> {
  if (mode === 'missing') return {};
  const source = {
    healthy:
      'export const publint = () => {}; export const checkPackage = () => {}; export const createPackageFromTarballData = () => {};',
    initializer: 'throw new Error("fixture initializer failed");',
    syntax: 'export const invalid = ;',
    transitive: 'import "./missing-transitive.mjs";',
    entry: '',
    'hidden-metadata': 'throw new Error("hidden metadata initializer failed");',
    conditions:
      'export const publint = () => {}; export const checkPackage = () => {}; export const createPackageFromTarballData = () => {};',
  }[mode];
  const entry =
    mode === 'conditions'
      ? { import: './index.mjs', require: './require.cjs' }
      : mode === 'entry'
        ? './missing-entry.mjs'
        : './index.mjs';
  return {
    [`node_modules/${packageName}/package.json`]: JSON.stringify({
      name: packageName,
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': entry,
        './utils': './utils.mjs',
        ...(mode === 'hidden-metadata'
          ? {}
          : { './package.json': './package.json' }),
      },
    }),
    [`node_modules/${packageName}/index.mjs`]: source,
    [`node_modules/${packageName}/utils.mjs`]:
      'export const formatMessage = () => "";',
    [`node_modules/${packageName}/require.cjs`]:
      'throw new Error("wrong require condition");',
  };
}

describe.each([
  ['publint', 'loadPublintPeer'],
  ['@arethetypeswrong/core', 'loadAttwPeer'],
])('optional ESM package %s', (packageName, loaderName) => {
  it.each<Mode>([
    'healthy',
    'missing',
    'initializer',
    'syntax',
    'transitive',
    'entry',
    'hidden-metadata',
    'conditions',
  ])('distinguishes %s without masking installed failures', async (mode) => {
    const fixture = await createSemanticRepairFixture({
      'package.json': '{"private":true,"type":"module"}',
      'hook.mjs': hook,
      'worker.mjs': worker,
      ...peerFiles(packageName, mode),
    });
    try {
      const output = await execFileAsync(
        process.execPath,
        [
          '--import',
          pathToFileURL(requireFromTest.resolve('tsx')).href,
          fixture.path('worker.mjs'),
          packageName,
          peerToolsUrl,
          loaderName,
        ],
        { cwd: fixture.root },
      );
      const result = JSON.parse(output.stdout) as {
        status: string;
        name?: string;
        message?: string;
      };
      if (mode === 'healthy' || mode === 'conditions') {
        expect(result).toEqual({ status: 'loaded' });
      } else if (mode === 'missing') {
        expect(result).toMatchObject({
          status: 'error',
          name: 'LiminaOptionalToolMissingError',
        });
      } else {
        expect(result.status).toBe('error');
        expect(result.name).not.toBe('LiminaOptionalToolMissingError');
        expect(result.message).toBeTruthy();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
