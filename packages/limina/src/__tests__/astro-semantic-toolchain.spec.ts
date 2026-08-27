import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveAstroSemanticAdapter,
  resolveAstroSemanticToolchain,
} from '../checker/astro-semantic-toolchain';
import { LiminaDependencyError } from '../dependency-contract';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);
const liminaPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function linkInstalledPackage(options: {
  installedName: string;
  packageName: string;
  rootDir: string;
}): Promise<void> {
  const segments = options.packageName.split('/');
  const packageBaseName = segments.pop()!;
  const targetDir = path.join(options.rootDir, 'node_modules', ...segments);
  await mkdir(targetDir, { recursive: true });
  await symlink(
    path.join(
      liminaPackageRoot,
      'node_modules',
      ...options.installedName.split('/'),
    ),
    path.join(targetDir, packageBaseName),
    'junction',
  );
}

async function createInstalledToolchainFixture(options: {
  astroInstalledName: string;
  astroVersion: string;
}): Promise<{ cleanup: () => Promise<void>; rootDir: string }> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-installed-astro-toolchain-')),
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    manifest({
      dependencies: {
        '@astrojs/check': '0.9.10',
        astro: options.astroVersion,
        typescript: '6.0.3',
      },
      name: 'installed-toolchain-fixture',
      version: '1.0.0',
    }),
  );
  await Promise.all([
    linkInstalledPackage({
      installedName: '@astrojs/check',
      packageName: '@astrojs/check',
      rootDir,
    }),
    linkInstalledPackage({
      installedName: options.astroInstalledName,
      packageName: 'astro',
      rootDir,
    }),
    linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir,
    }),
  ]);
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    rootDir,
  };
}

function manifest(options: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
  version?: string;
}): string {
  return `${JSON.stringify({ main: 'index.cjs', ...options })}\n`;
}

async function createToolchainFixture(
  options: {
    brokenCompilerSync?: boolean;
    brokenAstroCore?: boolean;
    declareCheck?: boolean;
    declareLanguageServer?: boolean;
    missingAstroCore?: boolean;
    versionlessLeaf?: boolean;
  } = {},
): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-astro-toolchain-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  const realTypeScriptEntry = requireFromTest.resolve('typescript');
  const files: Record<string, string> = {
    'package.json': manifest({
      dependencies: {
        astro: '7.2.0',
        ...(options.declareCheck === false
          ? {}
          : { '@astrojs/check': '0.9.10' }),
        ...(options.declareLanguageServer === false
          ? { '@astrojs/language-server': '2.16.13' }
          : {}),
        typescript: '6.0.3',
      },
      name: 'fixture',
      version: options.versionlessLeaf ? undefined : '1.0.0',
    }),
    'node_modules/astro/package.json': manifest({
      name: 'astro',
      version: '7.2.0',
    }),
    'node_modules/typescript/index.cjs': `module.exports = require(${JSON.stringify(realTypeScriptEntry)});\n`,
    'node_modules/typescript/package.json': manifest({
      name: 'typescript',
      version: '6.0.3',
    }),
    'node_modules/@astrojs/check/index.cjs': 'module.exports = {};\n',
    'node_modules/@astrojs/check/package.json': manifest({
      dependencies:
        options.declareLanguageServer === false
          ? {}
          : { '@astrojs/language-server': '2.16.13' },
      name: '@astrojs/check',
      peerDependencies: { typescript: '^5.0.0 || ^6.0.0' },
      version: '0.9.10',
    }),
    'node_modules/@astrojs/check/node_modules/typescript/index.cjs': `module.exports = require(${JSON.stringify(realTypeScriptEntry)});\n`,
    'node_modules/@astrojs/check/node_modules/typescript/package.json':
      manifest({ name: 'typescript', version: '6.0.3' }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/index.cjs':
      'module.exports = {};\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/package.json':
      manifest({
        dependencies: {
          '@astrojs/compiler': '2.13.1',
          '@volar/kit': '2.4.28',
          '@volar/language-core': '2.4.28',
          'vscode-uri': '3.1.0',
        },
        name: '@astrojs/language-server',
        version: '2.16.13',
      }),
    ...(options.missingAstroCore === true
      ? {}
      : {
          'node_modules/@astrojs/check/node_modules/@astrojs/language-server/dist/core/index.js':
            options.brokenAstroCore === true
              ? 'module.exports = { addAstroTypes() {} };\n'
              : 'module.exports = { addAstroTypes() {}, getAstroLanguagePlugin() { return { getLanguageId() {}, createVirtualCode() {}, typescript: { extraFileExtensions: [], getServiceScript() {} } }; } };\n',
        }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/dist/core/vue.js':
      'module.exports = { getVueLanguagePlugin() { return { getLanguageId() {}, createVirtualCode() {}, typescript: { extraFileExtensions: [], getServiceScript() {} } }; } };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/dist/core/svelte.js':
      'module.exports = { getSvelteLanguagePlugin() { return { getLanguageId() {}, createVirtualCode() {}, typescript: { extraFileExtensions: [], getServiceScript() {} } }; } };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@astrojs/compiler/index.cjs':
      'module.exports = {};\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@astrojs/compiler/sync.cjs':
      options.brokenCompilerSync === true
        ? 'module.exports = {};\n'
        : 'module.exports = { convertToTSX() {} };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@astrojs/compiler/package.json':
      manifest({
        exports: { '.': './index.cjs', './sync': './sync.cjs' },
        name: '@astrojs/compiler',
        version: '2.13.1',
      }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/language-core/index.cjs':
      'module.exports = { createLanguage() {}, forEachEmbeddedCode() {} };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/language-core/package.json':
      manifest({
        exports: { '.': './index.cjs' },
        name: '@volar/language-core',
        version: '2.4.28',
      }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/kit/index.cjs':
      'module.exports = {};\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/kit/package.json':
      manifest({
        dependencies: { '@volar/typescript': '2.4.28' },
        name: '@volar/kit',
        version: '2.4.28',
      }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/kit/node_modules/@volar/typescript/index.cjs':
      'module.exports = { createLanguageServiceHost() {} };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/@volar/kit/node_modules/@volar/typescript/package.json':
      manifest({ name: '@volar/typescript', version: '2.4.28' }),
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/vscode-uri/index.cjs':
      'module.exports = { URI: { file(value) { return { fsPath: value, path: value, toString() { return value; } }; } } };\n',
    'node_modules/@astrojs/check/node_modules/@astrojs/language-server/node_modules/vscode-uri/package.json':
      manifest({ name: 'vscode-uri', version: '3.1.0' }),
  };
  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(fixturePath(...relativePath.split('/')), text);
  }
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: fixturePath,
    rootDir,
  };
}

describe('Astro semantic toolchain', () => {
  it.each([
    ['astro-v7-min', '7.0.0'],
    ['astro-v7-current', '7.2.0'],
  ])(
    'loads the real %s owner chain as a supported Astro %s fixture',
    async (astroInstalledName, astroVersion) => {
      const fixture = await createInstalledToolchainFixture({
        astroInstalledName,
        astroVersion,
      });
      try {
        const toolchain = resolveAstroSemanticToolchain(fixture.rootDir);
        expect(toolchain.adapter).toEqual({
          family: 'astro-7-check-0.9',
          kind: 'supported',
        });
        expect(toolchain.versions).toMatchObject({
          astro: astroVersion,
          check: '0.9.10',
          compiler: '2.13.1',
          languageCore: '2.4.28',
          languageServer: '2.16.13',
          volarKit: '2.4.28',
          volarTypeScript: '2.4.28',
        });
        expect(toolchain.paths.check.startsWith(fixture.rootDir)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['5.4.5', '5.9.3', '6.0.3'])(
    'accepts Astro 7 with supported TypeScript %s',
    (typeScript) => {
      expect(
        resolveAstroSemanticAdapter({
          astro: '7.0.0',
          check: '0.9.10',
          compiler: '2.13.1',
          languageCore: '2.4.28',
          languageServer: '2.16.13',
          leafTypeScript: typeScript,
          typeScript,
          volarKit: '2.4.28',
          volarTypeScript: '2.4.28',
        }),
      ).toEqual({ family: 'astro-7-check-0.9', kind: 'supported' });
    },
  );

  it('treats Astro 7.0.0 as a floor and checks each split TypeScript version against the declared range', () => {
    const base = {
      astro: '7.2.0',
      check: '0.9.10',
      compiler: '2.13.1',
      languageCore: '2.4.28',
      languageServer: '2.16.13',
      leafTypeScript: '6.0.3',
      typeScript: '6.0.3',
      volarKit: '2.4.28',
      volarTypeScript: '2.4.28',
    };
    expect(resolveAstroSemanticAdapter(base).kind).toBe('supported');
    expect(resolveAstroSemanticAdapter({ ...base, astro: '8.0.0' }).kind).toBe(
      'unsupported',
    );
    expect(
      resolveAstroSemanticAdapter({ ...base, languageServer: '2.16.12' }).kind,
    ).toBe('unsupported');
    expect(
      resolveAstroSemanticAdapter({ ...base, leafTypeScript: '5.9.3' }).kind,
    ).toBe('supported');
    expect(
      resolveAstroSemanticAdapter({ ...base, leafTypeScript: '5.3.3' }).kind,
    ).toBe('unsupported');
    expect(
      resolveAstroSemanticAdapter({ ...base, typeScript: '6.1.0' }).kind,
    ).toBe('unsupported');
  });

  it.each([
    ['check', '0.9.9'],
    ['languageServer', '2.16.12'],
    ['compiler', '2.13.0'],
    ['languageCore', '2.4.27'],
    ['volarKit', '2.4.27'],
    ['volarTypeScript', '2.4.27'],
  ] as const)('rejects an unsupported exact %s tuple member', (key, value) => {
    const tuple = {
      astro: '7.2.0',
      check: '0.9.10',
      compiler: '2.13.1',
      languageCore: '2.4.28',
      languageServer: '2.16.13',
      leafTypeScript: '6.0.3',
      typeScript: '6.0.3',
      volarKit: '2.4.28',
      volarTypeScript: '2.4.28',
    };
    expect(resolveAstroSemanticAdapter({ ...tuple, [key]: value }).kind).toBe(
      'unsupported',
    );
  });

  it('resolves every package from its declared owner scope and accepts different TypeScript paths', async () => {
    const fixture = await createToolchainFixture();
    try {
      const toolchain = resolveAstroSemanticToolchain(fixture.rootDir);
      expect(toolchain.adapter.kind).toBe('supported');
      expect(toolchain.paths.leafTypeScript).not.toBe(
        toolchain.paths.typeScript,
      );
      expect(toolchain.versions.leafTypeScript).toBe(
        toolchain.versions.typeScript,
      );
      expect(toolchain.paths.languageServer).toContain(
        toPortablePath(path.join('@astrojs', 'check', 'node_modules')),
      );
      expect(toolchain.paths.volarTypeScript).toContain(
        toPortablePath(path.join('@volar', 'kit', 'node_modules')),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts a versionless leaf and package exports that hide internal manifests', async () => {
    const fixture = await createToolchainFixture({ versionlessLeaf: true });
    try {
      expect(resolveAstroSemanticToolchain(fixture.rootDir).adapter.kind).toBe(
        'supported',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects root fallback and missing internal API shape', async () => {
    const rootFallback = await createToolchainFixture({ declareCheck: false });
    const brokenShape = await createToolchainFixture({
      brokenAstroCore: true,
    });
    try {
      expect(() => resolveAstroSemanticToolchain(rootFallback.rootDir)).toThrow(
        /workspace-root fallback is not permitted/u,
      );
      expect(() => resolveAstroSemanticToolchain(brokenShape.rootDir)).toThrow(
        /approved Astro semantic adapter API shape/u,
      );
    } finally {
      await Promise.all([rootFallback.cleanup(), brokenShape.cleanup()]);
    }
  });

  it('rejects a missing internal adapter module', async () => {
    const fixture = await createToolchainFixture({ missingAstroCore: true });
    try {
      expect(() => resolveAstroSemanticToolchain(fixture.rootDir)).toThrow(
        /Cannot find module/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an incompatible LS-owned compiler API shape', async () => {
    const fixture = await createToolchainFixture({
      brokenCompilerSync: true,
    });
    try {
      expect(() => resolveAstroSemanticToolchain(fixture.rootDir)).toThrow(
        /LS-owned @astrojs\/compiler\/sync does not expose/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a root-visible language server that is not declared by check', async () => {
    const fixture = await createToolchainFixture({
      declareLanguageServer: false,
    });
    try {
      expect(() => resolveAstroSemanticToolchain(fixture.rootDir)).toThrow(
        /not declared by the owner scope/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps machine paths out of stable toolchain issue identity', async () => {
    const left = await createToolchainFixture({ brokenAstroCore: true });
    const right = await createToolchainFixture({ brokenAstroCore: true });
    try {
      const readIdentity = (rootDir: string): string => {
        try {
          resolveAstroSemanticToolchain(rootDir);
          throw new Error('Expected the toolchain to be rejected.');
        } catch (error) {
          expect(error).toBeInstanceOf(LiminaDependencyError);
          return (error as LiminaDependencyError).issueIdentity;
        }
      };
      expect(readIdentity(left.rootDir)).toBe(readIdentity(right.rootDir));
    } finally {
      await Promise.all([left.cleanup(), right.cleanup()]);
    }
  });
});
