import { isPlainRecord } from '#utils/values';
import { createRequire } from 'node:module';
import path from 'node:path';
import semver from 'semver';
import type ts from 'typescript';
import { resolveAstroSemanticAdapter } from './astro-semantic-compatibility';
import type {
  AstroFrameworkPluginRuntime,
  AstroLanguageCoreRuntime,
  AstroLanguageServerCoreRuntime,
  AstroSemanticToolchain,
  AstroSemanticToolchainPaths,
  AstroSemanticVersionTuple,
  AstroVolarTypeScriptRuntime,
  AstroVscodeUriRuntime,
} from './astro-semantic-types';

function hasFunctions(
  value: Record<string, unknown>,
  properties: readonly string[],
): boolean {
  return properties.every((property) => typeof value[property] === 'function');
}

function assertRuntime<T>(options: {
  label: string;
  properties: readonly string[];
  value: unknown;
}): T {
  if (
    !isPlainRecord(options.value) ||
    !hasFunctions(options.value, options.properties)
  ) {
    throw new TypeError(
      `${options.label} does not expose the approved Astro semantic adapter API shape.`,
    );
  }
  return options.value as T;
}

function assertTypeScriptRuntime(value: unknown): typeof ts {
  return assertRuntime<typeof ts>({
    label: 'The check-visible TypeScript package',
    properties: [
      'createModuleResolutionCache',
      'createSourceFile',
      'getModeForUsageLocation',
      'readJsonConfigFile',
    ],
    value,
  });
}

function hasUriFile(value: unknown): boolean {
  if (typeof value === 'function') {
    return typeof (value as { file?: unknown }).file === 'function';
  }
  if (!isPlainRecord(value)) return false;
  return typeof value.file === 'function';
}

function assertVscodeUriRuntime(value: unknown): AstroVscodeUriRuntime {
  if (!isPlainRecord(value)) {
    throw new TypeError(
      'vscode-uri does not expose the approved URI.file adapter API shape.',
    );
  }
  if (!hasUriFile(value.URI)) {
    throw new TypeError(
      'vscode-uri does not expose the approved URI.file adapter API shape.',
    );
  }
  return value as unknown as AstroVscodeUriRuntime;
}

function hasLanguagePluginShape(
  value: unknown,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (typeof value.getLanguageId !== 'function') return false;
  return typeof value.createVirtualCode === 'function';
}

function hasTypeScriptPluginShape(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (!Array.isArray(value.extraFileExtensions)) return false;
  return typeof value.getServiceScript === 'function';
}

function assertLanguagePluginShape(options: {
  label: string;
  value: unknown;
}): ReturnType<AstroFrameworkPluginRuntime['getLanguagePlugin']> {
  if (!hasLanguagePluginShape(options.value)) {
    throw new TypeError(
      `${options.label} does not expose the approved Astro semantic language-plugin shape.`,
    );
  }
  if (!hasTypeScriptPluginShape(options.value.typescript)) {
    throw new TypeError(
      `${options.label} does not expose the approved Astro semantic language-plugin shape.`,
    );
  }
  return options.value as ReturnType<
    AstroFrameworkPluginRuntime['getLanguagePlugin']
  >;
}

function requireInternalModule(options: {
  manifestPath: string;
  relativePath: string;
}): unknown {
  return createRequire(options.manifestPath)(
    path.join(path.dirname(options.manifestPath), options.relativePath),
  ) as unknown;
}

export function loadAstroSemanticRuntime(options: {
  paths: AstroSemanticToolchainPaths;
  versions: AstroSemanticVersionTuple;
}): AstroSemanticToolchain {
  const requireFromLanguageServer = createRequire(options.paths.languageServer);
  const requireFromVolarKit = createRequire(options.paths.volarKit);
  assertRuntime({
    label: 'LS-owned @astrojs/compiler/sync',
    properties: ['convertToTSX'],
    value: requireFromLanguageServer('@astrojs/compiler/sync') as unknown,
  });
  const astroCore = assertRuntime<AstroLanguageServerCoreRuntime>({
    label: '@astrojs/language-server core',
    properties: ['addAstroTypes', 'getAstroLanguagePlugin'],
    value: requireInternalModule({
      manifestPath: options.paths.languageServer,
      relativePath: 'dist/core/index.js',
    }),
  });
  const vueModule = assertRuntime<{
    getVueLanguagePlugin(): ReturnType<
      AstroFrameworkPluginRuntime['getLanguagePlugin']
    >;
  }>({
    label: '@astrojs/language-server Vue plugin',
    properties: ['getVueLanguagePlugin'],
    value: requireInternalModule({
      manifestPath: options.paths.languageServer,
      relativePath: 'dist/core/vue.js',
    }),
  });
  const svelteModule = assertRuntime<{
    getSvelteLanguagePlugin(): ReturnType<
      AstroFrameworkPluginRuntime['getLanguagePlugin']
    >;
  }>({
    label: '@astrojs/language-server Svelte plugin',
    properties: ['getSvelteLanguagePlugin'],
    value: requireInternalModule({
      manifestPath: options.paths.languageServer,
      relativePath: 'dist/core/svelte.js',
    }),
  });
  const astroPlugin = assertLanguagePluginShape({
    label: '@astrojs/language-server Astro plugin',
    value: astroCore.getAstroLanguagePlugin(),
  });
  const vuePlugin = assertLanguagePluginShape({
    label: '@astrojs/language-server Vue plugin',
    value: vueModule.getVueLanguagePlugin(),
  });
  const sveltePlugin = assertLanguagePluginShape({
    label: '@astrojs/language-server Svelte plugin',
    value: svelteModule.getSvelteLanguagePlugin(),
  });
  return {
    adapter: resolveAstroSemanticAdapter(options.versions),
    astroCore: {
      ...astroCore,
      getAstroLanguagePlugin: () => astroPlugin,
    },
    astroInstall: {
      directory: path.dirname(options.paths.astro),
      version: new semver.SemVer(options.versions.astro),
    },
    languageCore: assertRuntime<AstroLanguageCoreRuntime>({
      label: '@volar/language-core',
      properties: ['createLanguage', 'forEachEmbeddedCode'],
      value: requireFromLanguageServer('@volar/language-core') as unknown,
    }),
    paths: options.paths,
    sveltePlugin: {
      getLanguagePlugin: () => sveltePlugin,
    } satisfies AstroFrameworkPluginRuntime,
    tsModule: assertTypeScriptRuntime(
      createRequire(options.paths.check)('typescript') as unknown,
    ),
    versions: options.versions,
    volarTypeScript: assertRuntime<AstroVolarTypeScriptRuntime>({
      label: '@volar/typescript',
      properties: ['createLanguageServiceHost'],
      value: requireFromVolarKit('@volar/typescript') as unknown,
    }),
    vscodeUri: assertVscodeUriRuntime(
      requireFromLanguageServer('vscode-uri') as unknown,
    ),
    vuePlugin: {
      getLanguagePlugin: () => vuePlugin,
    } satisfies AstroFrameworkPluginRuntime,
  };
}
