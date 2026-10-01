import licensePlugin from '@limina/build-tools/license';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import {
  defineConfig,
  type PluginContext,
  type RolldownOptions,
} from 'rolldown';
import package_ from './package.json' with { type: 'json' };
import packagePlugin from './packagePlugin';
import { migrationBuildInfo } from './src/build-info';

const packageDirectory = fileURLToPath(new URL('.', import.meta.url));
const distributionState = { hasCleaned: false };
const packageExternalDependencies = [
  ...Object.keys(package_.dependencies || {}),
  ...Object.keys(package_.peerDependencies || {}),
  // @ts-expect-error No type checking is needed here.
  ...Object.keys(package_.optionalDependencies ?? {}),
];

function isPackageExternal(id: string): boolean {
  return packageExternalDependencies.some(
    (dependencyName) =>
      id === dependencyName || id.startsWith(`${dependencyName}/`),
  );
}

function resolveJsoncParserEsmEntry(): string {
  const packageJsonPath = fileURLToPath(
    import.meta.resolve('jsonc-parser/package.json'),
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    module?: unknown;
  };

  if (
    typeof packageJson.module !== 'string' ||
    packageJson.module.length === 0
  ) {
    throw new TypeError(
      'jsonc-parser package.json must define a module entry.',
    );
  }

  return path.resolve(path.dirname(packageJsonPath), packageJson.module);
}

const jsoncParserEsmEntry = resolveJsoncParserEsmEntry();

const coreSourceDirectory = path.normalize(
  realpathSync(path.resolve(packageDirectory, '../limina/src')),
);
const coreSupportEntry = path.join(
  coreSourceDirectory,
  'internal/migration.ts',
);

function modulePackageName(
  id: string,
  owners: Map<string, string | undefined>,
): string | undefined {
  if (!path.isAbsolute(id)) return undefined;
  let directory = path.dirname(id);
  const visited: string[] = [];
  let name: string | undefined;
  while (directory !== path.dirname(directory)) {
    if (owners.has(directory)) {
      name = owners.get(directory);
      break;
    }
    visited.push(directory);
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      name = (
        JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      ).name;
      break;
    }
    directory = path.dirname(directory);
  }
  for (const entry of visited) owners.set(entry, name);
  return name;
}

function isWorkspaceOnlySpecifier(id: string): boolean {
  return (
    id === 'limina' ||
    id.startsWith('limina/') ||
    id.startsWith('@limina/') ||
    id.startsWith('#')
  );
}

function embeddedCorePlugin(): NonNullable<RolldownOptions['plugins']> {
  return {
    name: 'rolldown-plugin-embedded-migration-core',
    buildStart(this: PluginContext) {
      if (
        migrationBuildInfo.coreVersion !== migrationBuildInfo.migrateVersion
      ) {
        this.error(
          'Migration must embed the same-release Limina source version.',
        );
      }
    },
    resolveId(source) {
      return source === 'limina/internal/migration' ? coreSupportEntry : null;
    },
    generateBundle(this: PluginContext, _options, bundle) {
      const modules = [...this.getModuleIds()];
      if (modules.every((id) => path.normalize(id) !== coreSupportEntry)) {
        this.error(
          'Migration must embed the current Limina source support entry.',
        );
      }
      const owners = new Map<string, string | undefined>();
      const coreModules = new Set<string>();
      for (const moduleId of modules) {
        const id = path.normalize(moduleId);
        const info = this.getModuleInfo(moduleId);
        for (const imported of [
          id,
          ...(info?.importedIds ?? []),
          ...(info?.dynamicallyImportedIds ?? []),
        ]) {
          if (isWorkspaceOnlySpecifier(imported))
            this.error(
              `Migration contains a workspace-only external: ${imported}`,
            );
        }
        if (info?.code === null || modulePackageName(id, owners) !== 'limina')
          continue;
        if (
          !id.startsWith(`${coreSourceDirectory}/`) &&
          id !== path.resolve(coreSourceDirectory, '../package.json')
        ) {
          this.error(
            `Migration core must resolve from current source, not distribution: ${id}`,
          );
        }
        const identity = path.normalize(realpathSync(id));
        if (coreModules.has(identity))
          this.error(
            `Migration contains duplicate core module instances: ${id}`,
          );
        coreModules.add(identity);
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const imported of [...output.imports, ...output.dynamicImports]) {
          if (isWorkspaceOnlySpecifier(imported))
            this.error(
              `Migration contains a workspace-only external: ${imported}`,
            );
        }
        if (
          output.code.includes(packageDirectory) ||
          output.code.includes(coreSourceDirectory)
        ) {
          this.error(`Migration contains a checkout path: ${output.fileName}`);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'migration-build.json',
        source: `${JSON.stringify(migrationBuildInfo, null, 2)}\n`,
      });
    },
  };
}

const jsoncParserEsmPlugin = (): NonNullable<RolldownOptions['plugins']> => ({
  name: 'rolldown-plugin-jsonc-parser-esm',
  resolveId(source) {
    return source === 'jsonc-parser' ? jsoncParserEsmEntry : null;
  },
});

const cleanDistributionPlugin = (): NonNullable<
  RolldownOptions['plugins']
> => ({
  name: 'rolldown-plugin-clean-dist',
  async buildStart() {
    if (distributionState.hasCleaned) {
      return;
    }

    distributionState.hasCleaned = true;
    await rm(path.resolve(packageDirectory, 'dist'), {
      force: true,
      recursive: true,
    });
  },
});

const moduleConfig: RolldownOptions = defineConfig({
  input: {
    cli: 'src/cli.ts',
    'migration-verify-process': 'src/migration/verify-process.ts',
    'flow-renderer-process': '../limina/src/flow/renderer-process.ts',
    'bin/limina-migrate': 'bin/limina-migrate.js',
  },
  platform: 'node',
  preserveEntrySignatures: 'strict',
  external: isPackageExternal,
  plugins: [
    cleanDistributionPlugin(),
    embeddedCorePlugin(),
    // Prefer jsonc-parser's ESM `module` entry because its 3.x UMD `main` entry
    // uses indirect `require` calls that cannot be reliably analyzed by bundlers.
    // Remove this override after upgrading to the ESM-only jsonc-parser 4.x.
    jsoncParserEsmPlugin(),
    packagePlugin(),
    licensePlugin(
      path.resolve(packageDirectory, 'LICENSE.md'),
      'limina-migrate license',
      'limina-migrate',
      path.resolve(packageDirectory, '../../LICENSE'),
    ),
  ],
  output: {
    dir: 'dist',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/dep-[hash].js',
    exports: 'named',
    format: 'esm',
  },
});

export default moduleConfig;
