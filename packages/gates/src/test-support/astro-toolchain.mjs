// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * @typedef {'astro' | 'astro-v7-min'} AstroTestPackage
 */
/**
 * @typedef {object} AstroTestToolchain
 * @property {Record<'astro' | '@astrojs/check' | 'typescript', string>} dependencies
 * @property {Record<string, string>} overrides
 */

/**
 * @param {string} manifestPath
 */
function readVersion(manifestPath) {
  const manifest = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(manifestPath, 'utf8'))
  );
  return manifest.version;
}

/**
 * @param {NodeRequire} request
 * @param {string} name
 * @param {string} [packageName]
 */
function installedManifest(request, name, packageName = name) {
  try {
    return request.resolve(`${name}/package.json`);
  } catch {
    let directory = path.dirname(request.resolve(name));
    while (true) {
      const candidate = path.join(directory, 'package.json');
      if (existsSync(candidate)) {
        const manifest = /** @type {{ name?: string }} */ (
          JSON.parse(readFileSync(candidate, 'utf8'))
        );
        if (manifest.name === packageName) return candidate;
      }
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error(`Unable to locate ${packageName} for ${name}.`);
      directory = parent;
    }
  }
}

// Catalogs and the frozen workspace installation select the versions. Read
// manifests through their owners; fixtures must not maintain a second tuple.
/**
 * @param {NodeRequire} ownerRequire
 * @param {AstroTestPackage} [astroPackage]
 * @returns {AstroTestToolchain}
 */
export function readAstroTestToolchain(ownerRequire, astroPackage = 'astro') {
  const checkManifest = installedManifest(ownerRequire, '@astrojs/check');
  const checkRequire = createRequire(checkManifest);
  const serverManifest = checkRequire.resolve(
    '@astrojs/language-server/package.json',
  );
  const serverRequire = createRequire(serverManifest);
  const kitManifest = serverRequire.resolve('@volar/kit/package.json');
  const kitRequire = createRequire(kitManifest);

  return {
    dependencies: {
      '@astrojs/check': readVersion(checkManifest),
      astro: readVersion(
        installedManifest(ownerRequire, astroPackage, 'astro'),
      ),
      typescript: readVersion(installedManifest(ownerRequire, 'typescript')),
    },
    overrides: {
      '@astrojs/check>@astrojs/language-server': readVersion(serverManifest),
      '@astrojs/language-server>@astrojs/compiler': readVersion(
        serverRequire.resolve('@astrojs/compiler/package.json'),
      ),
      '@astrojs/language-server>@volar/language-core': readVersion(
        serverRequire.resolve('@volar/language-core/package.json'),
      ),
      '@astrojs/language-server>@volar/kit': readVersion(kitManifest),
      '@volar/kit>@volar/typescript': readVersion(
        kitRequire.resolve('@volar/typescript/package.json'),
      ),
    },
  };
}
