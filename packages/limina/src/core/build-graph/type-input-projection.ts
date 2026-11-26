import path from 'pathe';
import ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { isRelativeTypeName } from '../typescript-semantic/effective-roots';
import { observedConfigSystem } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import {
  collectConfigTypeInputs,
  type EffectiveTypeInput,
} from './config-type-inputs';
import { libraryProjectionFiles } from './library-projection';
import type { SourceProject } from './types';

export interface TypeInputProjectionReceipt {
  scope: 'config-type-directives';
  version: 4;
  compilerVersion: string;
  sourceConfig: string;
  generatedConfig: string;
  sourceOptions: ts.CompilerOptions;
  generatedOptions: ts.CompilerOptions;
  source: EffectiveTypeInput[];
  generated: EffectiveTypeInput[];
}

function compilerFor(project: SourceProject): typeof ts {
  return project.context.vueSemanticIdentity?.toolchain.tsModule ?? ts;
}

export function sourceTypeInputs(
  project: SourceProject,
  cache?: NativeAnalysisCache,
): EffectiveTypeInput[] {
  return collectConfigTypeInputs({
    compiler: compilerFor(project),
    configPath: project.configPath,
    options: project.options,
    cache,
  });
}

function projectedOptions(
  project: SourceProject,
  generatedConfig: string,
  overrides: Record<string, unknown>,
): ts.CompilerOptions {
  const compiler = compilerFor(project);
  const host = withVirtualResolutionFiles(
    observedConfigSystem(compiler, project.configPath),
    project.virtualFiles,
  );
  const parsed = compiler.parseJsonConfigFileContent(
    {
      extends: project.configPath,
      compilerOptions: overrides,
      files: project.fileNames,
      include: [],
    },
    host,
    path.dirname(generatedConfig),
    undefined,
    generatedConfig,
  );
  if (parsed.errors.length > 0)
    throw new Error(
      `Cannot parse generated compiler options: ${generatedConfig}: ${parsed.errors.map((error) => compiler.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`,
    );
  return effectiveCompilerOptions(parsed.options);
}

/**
Preserve selected entries, not the complete type environment.
*/
export function projectTypeDirectiveNames(
  project: SourceProject,
  generatedConfig: string,
  projection: {
    overrides: Record<string, unknown>;
    cache?: NativeAnalysisCache;
    files?: ReadonlyMap<string, string>;
  },
): string[] {
  const { overrides, cache } = projection;
  const compiler = compilerFor(project);
  const source = sourceTypeInputs(project, cache);
  // Explicit typeRoots already anchor compiler lookup, including a miss.
  // Otherwise preserve the source selection before probing the generated
  // configuration so materialization cannot invalidate its own lookup.
  const names = source.map((entry) =>
    project.options.typeRoots === undefined && isRelativeTypeName(entry.name)
      ? (entry.originalPath ??
        entry.target ??
        path.resolve(path.dirname(project.configPath), entry.name))
      : entry.name,
  );
  const options = projectedOptions(project, generatedConfig, {
    ...overrides,
    types: names,
  });
  const generated = collectConfigTypeInputs({
    compiler,
    configPath: generatedConfig,
    sourceConfigPath: project.configPath,
    options,
    cache,
    files: projection.files,
  });
  return source.map((entry, index) =>
    shouldPinTypeInput(entry, generated[index])
      ? (entry.originalPath ?? entry.target!)
      : names[index]!,
  );
}

export function proveTypeInputProjection(
  project: SourceProject,
  generatedConfig: string,
  projection: {
    overrides: Record<string, unknown>;
    cache?: NativeAnalysisCache;
  },
): TypeInputProjectionReceipt {
  const { overrides, cache } = projection;
  const compiler = compilerFor(project);
  const generatedOptions = projectedOptions(
    project,
    generatedConfig,
    overrides,
  );
  const source = sourceTypeInputs(project, cache);
  const generated = collectConfigTypeInputs({
    compiler,
    configPath: generatedConfig,
    sourceConfigPath: project.configPath,
    options: generatedOptions,
    cache,
    files: new Map(
      (project.libraryProjections ?? [])
        .filter((receipt) => receipt.generatedConfig === generatedConfig)
        .flatMap((receipt) => [...libraryProjectionFiles(receipt)]),
    ),
  });
  if (!hasEquivalentTypeInputs(source, generated)) {
    throw new Error(
      `Type input projection cannot preserve config-type-directives:\n  source: ${project.configPath}\n  generated: ${generatedConfig}\n  source entries: ${JSON.stringify(source)}\n  generated entries: ${JSON.stringify(generated)}`,
    );
  }
  return {
    scope: 'config-type-directives',
    version: 4,
    compilerVersion: compiler.version,
    sourceConfig: project.configPath,
    generatedConfig,
    sourceOptions: effectiveCompilerOptions(project.options),
    generatedOptions,
    source,
    generated,
  };
}

function hasEquivalentTypeInputs(
  source: EffectiveTypeInput[],
  generated: EffectiveTypeInput[],
): boolean {
  return (
    source.length === generated.length &&
    source.every((entry, index) => hasSameTypeInput(entry, generated[index]))
  );
}

function shouldPinTypeInput(
  entry: EffectiveTypeInput,
  generated: EffectiveTypeInput | undefined,
): boolean {
  return entry.target !== null && !hasSameTypeInput(entry, generated);
}

function hasSameTypeInput(
  entry: EffectiveTypeInput,
  generated: EffectiveTypeInput | undefined,
): boolean {
  return (
    entry.target === generated?.target &&
    entry.isExternalLibraryImport === generated?.isExternalLibraryImport
  );
}
