import { spawnSync } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cases = [
  {
    expectedVersions: {
      languageCore: '2.2.0',
      typeScript: '5.4.5',
      volarTypeScript: '2.4.11',
      vueTsc: '2.2.0',
    },
    name: 'vue-2.2.0-ts-5.4.5',
  },
  {
    expectedVersions: {
      languageCore: '2.2.10',
      typeScript: '5.9.3',
      volarTypeScript: '2.4.11',
      vueTsc: '2.2.10',
    },
    name: 'vue-2.2.10-ts-5.9.3',
  },
  {
    expectedVersions: {
      languageCore: '2.2.12',
      typeScript: '5.9.3',
      volarTypeScript: '2.4.28',
      vueTsc: '2.2.12',
    },
    name: 'vue-2.2.12-ts-5.9.3',
  },
  {
    expectedVersions: {
      languageCore: '3.2.0',
      typeScript: '5.4.5',
      volarTypeScript: '2.4.27',
      vueTsc: '3.2.0',
    },
    name: 'vue-3.2.0-ts-5.4.5',
  },
  {
    expectedVersions: {
      languageCore: '3.2.4',
      typeScript: '6.0.3',
      volarTypeScript: '2.4.27',
      vueTsc: '3.2.4',
    },
    name: 'vue-3.2.4-ts-6.0.3',
  },
];

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function readManifestVersion(manifestPath) {
  const manifest = readManifest(manifestPath);
  if (typeof manifest.version === 'string') return manifest.version;
  throw new TypeError(`${manifestPath} does not expose a string version.`);
}

function hasInstalledPackageLink(caseDirectory, packageName) {
  try {
    accessSync(
      path.join(caseDirectory, 'node_modules', ...packageName.split('/')),
    );
    return true;
  } catch {
    return false;
  }
}

function resolveInstalledCase(caseDirectory) {
  const requireFromCase = createRequire(
    path.join(caseDirectory, 'package.json'),
  );
  const liminaManifestPath = requireFromCase.resolve('limina/package.json');
  const liminaManifest = readManifest(liminaManifestPath);
  const requireFromLimina = createRequire(liminaManifestPath);
  const vueTscManifest = requireFromCase.resolve('vue-tsc/package.json');
  const requireFromVueTsc = createRequire(vueTscManifest);

  if (liminaManifest.name !== 'limina') {
    throw new Error(
      `${liminaManifestPath} does not describe the Limina package.`,
    );
  }
  if (typeof liminaManifest.bin?.limina !== 'string') {
    throw new Error(`${liminaManifestPath} does not expose bin.limina.`);
  }

  return {
    liminaCli: path.resolve(
      path.dirname(liminaManifestPath),
      liminaManifest.bin.limina,
    ),
    liminaManifest,
    optionalPeerInstalled: {
      svelte2tsx: hasInstalledPackageLink(caseDirectory, 'svelte2tsx'),
    },
    versions: {
      languageCore: readManifestVersion(
        requireFromVueTsc.resolve('@vue/language-core/package.json'),
      ),
      liminaTypeScript: readManifestVersion(
        requireFromLimina.resolve('typescript/package.json'),
      ),
      typeScript: readManifestVersion(
        requireFromCase.resolve('typescript/package.json'),
      ),
      volarTypeScript: readManifestVersion(
        requireFromVueTsc.resolve('@volar/typescript/package.json'),
      ),
      vueTsc: readManifestVersion(vueTscManifest),
      vueTscTypeScript: readManifestVersion(
        requireFromVueTsc.resolve('typescript/package.json'),
      ),
    },
  };
}

function assertExpectedVersions(testCase, actualVersions) {
  for (const [packageName, expectedVersion] of Object.entries(
    testCase.expectedVersions,
  )) {
    const actualVersion = actualVersions[packageName];
    if (actualVersion === expectedVersion) continue;
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} expected ${packageName} ${expectedVersion}, received ${actualVersion}.`,
    );
  }
}

function assertTypeScriptPeerResolution(testCase, actualVersions) {
  for (const packageName of ['liminaTypeScript', 'vueTscTypeScript']) {
    if (actualVersions[packageName] === testCase.expectedVersions.typeScript) {
      continue;
    }
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} expected ${packageName} ${testCase.expectedVersions.typeScript}, received ${actualVersions[packageName]}.`,
    );
  }
}

function assertLiminaDependencyContract(testCase, installed) {
  const { liminaManifest: manifest } = installed;
  for (const sectionName of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
  ]) {
    for (const packageName of ['oxc-parser', '@astrojs/compiler']) {
      if (manifest[sectionName]?.[packageName] === undefined) continue;
      throw new Error(
        `[vue-semantic-matrix] ${testCase.name} installed Limina still declares ${packageName} in ${sectionName}.`,
      );
    }
  }
  if (typeof manifest.dependencies?.['oxc-resolver'] !== 'string') {
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} installed Limina must retain oxc-resolver as a dependency.`,
    );
  }
  for (const sectionName of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
  ]) {
    if (manifest[sectionName]?.['@jridgewell/trace-mapping'] === undefined) {
      continue;
    }
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} installed Limina must keep @jridgewell/trace-mapping as development metadata only; found it in ${sectionName}.`,
    );
  }
  if (manifest.devDependencies?.['@jridgewell/trace-mapping'] !== '^0.3.31') {
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} installed Limina must retain @jridgewell/trace-mapping@^0.3.31 in devDependencies.`,
    );
  }
  for (const sectionName of ['dependencies', 'optionalDependencies']) {
    if (manifest[sectionName]?.svelte2tsx === undefined) continue;
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} installed Limina must not publish svelte2tsx in ${sectionName}.`,
    );
  }
  if (
    manifest.devDependencies?.svelte2tsx !== '^0.7.61' ||
    manifest.peerDependencies?.svelte2tsx !== '^0.7.61' ||
    manifest.peerDependenciesMeta?.svelte2tsx?.optional !== true
  ) {
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} installed Limina must retain svelte2tsx@^0.7.61 as development metadata and expose it as an optional peer.`,
    );
  }
  if (installed.optionalPeerInstalled.svelte2tsx) {
    throw new Error(
      `[vue-semantic-matrix] ${testCase.name} unexpectedly installed the Svelte-only svelte2tsx peer.`,
    );
  }
}

for (const testCase of cases) {
  const caseDirectory = fileURLToPath(
    new URL(`cases/${testCase.name}/`, import.meta.url),
  );
  const installed = resolveInstalledCase(caseDirectory);
  assertExpectedVersions(testCase, installed.versions);
  assertTypeScriptPeerResolution(testCase, installed.versions);
  assertLiminaDependencyContract(testCase, installed);
  try {
    accessSync(installed.liminaCli);
  } catch {
    throw new Error(
      `[vue-semantic-matrix] Installed Limina CLI is missing at ${installed.liminaCli}. Build Limina before installing the semantic matrix.`,
    );
  }
  console.log(
    `[vue-semantic-matrix] ${testCase.name} ${JSON.stringify(installed.versions)}`,
  );
  const result = spawnSync(process.execPath, [installed.liminaCli, 'check'], {
    cwd: caseDirectory,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) continue;
  process.exitCode = result.status ?? 1;
  break;
}
