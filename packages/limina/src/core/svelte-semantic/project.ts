import { cloneCompilerOptions } from '#utils/compiler-options';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseFrameworkProjectConfig } from '../../checker/framework-project-config';
import type { ResolvedConfigProjection } from '../../checker/resolved-config';
import type { AutoScopeProject } from '../build-graph/auto-checker-types';
import {
  SVELTE_SEMANTIC_ADAPTER_VERSION,
  type SvelteSemanticProject,
  type SvelteSourceConfig,
} from './types';

export function createSvelteSemanticProject(options: {
  readSourceConfig?: SvelteSemanticProject['readSourceConfig'];
  virtualFiles?: SvelteSemanticProject['virtualFiles'];
  references?: SvelteSemanticProject['references'];
  svelteOptions?: SvelteSemanticProject['svelteOptions'];
  configClosure?: SvelteSemanticProject['configClosure'];
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  options: ts.CompilerOptions;
  packageRootDir: string;
  resolverConfigPath?: string;
}): SvelteSemanticProject {
  return {
    readSourceConfig: options.readSourceConfig,
    virtualFiles: options.virtualFiles,
    references: options.references,
    svelteOptions: options.svelteOptions,
    adapterVersion: SVELTE_SEMANTIC_ADAPTER_VERSION,
    configClosure: options.configClosure,
    packageIdentity: createPackageIdentity(options.packageRootDir),
    configPath: normalizeAbsolutePath(options.configPath),
    extensions: [...options.extensions],
    fileNames: options.fileNames.map(normalizeAbsolutePath),
    generation: options.generation,
    options: options.options,
    packageRootDir: normalizeAbsolutePath(options.packageRootDir),
    resolverConfigPath: normalizeAbsolutePath(
      options.resolverConfigPath ?? options.configPath,
    ),
  };
}

export function parseSvelteConfig(input: {
  configPath: string;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
}): ResolvedConfigProjection {
  return parseFrameworkProjectConfig({
    ...input,
    extraFileExtensions: [
      {
        extension: 'svelte',
        isMixedContent: true,
        scriptKind: input.tsModule.ScriptKind.Deferred,
      },
    ],
  });
}

const sourceConfigReaders = new WeakMap<
  AutoScopeProject,
  NonNullable<SvelteSemanticProject['readSourceConfig']>
>();

export function svelteCompilerOptions(
  options: ts.CompilerOptions,
): ts.CompilerOptions {
  return cloneCompilerOptions(options, { allowNonTsExtensions: true });
}

export function getSvelteSourceConfigReader(
  source: AutoScopeProject,
): NonNullable<SvelteSemanticProject['readSourceConfig']> {
  let readSourceConfig = sourceConfigReaders.get(source);
  if (readSourceConfig === undefined) {
    const byCompiler = new WeakMap<typeof ts, SvelteSourceConfig>([
      [
        ts,
        {
          configClosure: source.configClosure,
          options: source.options,
          references: source.references,
          svelteOptions: source.svelteOptions,
        },
      ],
    ]);
    readSourceConfig = (tsModule) => {
      const existing = byCompiler.get(tsModule);
      if (existing !== undefined) return existing;
      const { configClosure, parsed } = parseSvelteConfig({
        configPath: source.configPath,
        tsModule,
        virtualFiles: source.virtualFiles,
      });
      const config = {
        configClosure,
        options: parsed.options,
        references: parsed.projectReferences ?? [],
        svelteOptions: parsed.raw.svelteOptions,
      };
      byCompiler.set(tsModule, config);
      return config;
    };
    sourceConfigReaders.set(source, readSourceConfig);
  }
  return readSourceConfig;
}

export function createSvelteSourceProject(input: {
  source: AutoScopeProject;
  packageRootDir: string;
  fileNames?: readonly string[];
}): SvelteSemanticProject {
  const { source } = input;
  return createSvelteSemanticProject({
    readSourceConfig: getSvelteSourceConfigReader(source),
    configClosure: source.configClosure,
    configPath: source.configPath,
    extensions: source.context.extensions,
    fileNames: input.fileNames ?? source.fileNames,
    generation: source.analysisGeneration,
    options: source.options,
    packageRootDir: input.packageRootDir,
    references: source.references,
    svelteOptions: svelteSemanticOptions(source.svelteOptions),
    virtualFiles: source.virtualFiles,
  });
}

export function svelteSemanticOptions(
  value: unknown,
): SvelteSemanticProject['svelteOptions'] {
  const namespace = isPlainRecord(value) ? value.namespace : undefined;
  return typeof namespace === 'string' ? { namespace } : undefined;
}

function createPackageIdentity(packageRootDirectory: string): string {
  const fileName = path.join(packageRootDirectory, 'package.json');
  try {
    return createHash('sha256')
      .update(normalizeAbsolutePath(realpathSync(fileName)))
      .update(readFileSync(fileName))
      .digest('hex');
  } catch {
    return 'missing';
  }
}
