import path from 'pathe';
import ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
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
function projectedOptions(
  project: SourceProject,
  generatedConfig: string,
  overrides: Record<string, unknown>,
): ts.CompilerOptions {
  const compiler = compilerFor(project);
  const host = withVirtualResolutionFiles(
    observedCompilerSystem(compiler, project.configPath),
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
  const source = collectConfigTypeInputs({
    compiler,
    configPath: project.configPath,
    options: project.options,
    cache,
  });
  const options = projectedOptions(project, generatedConfig, {
    ...overrides,
    types: source.map((entry) => entry.name),
  });
  const generated = collectConfigTypeInputs({
    compiler,
    configPath: generatedConfig,
    options,
    cache,
    files: projection.files,
  });
  return source.map((entry, index) =>
    shouldPinTypeInput(entry, generated[index])
      ? (entry.originalPath ?? entry.target!)
      : entry.name,
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
  const source = collectConfigTypeInputs({
    compiler,
    configPath: project.configPath,
    options: project.options,
    cache,
  });
  const generated = collectConfigTypeInputs({
    compiler,
    configPath: generatedConfig,
    options: generatedOptions,
    cache,
    files: new Map(
      (project.libraryProjections ?? [])
        .filter((receipt) => receipt.generatedConfig === generatedConfig)
        .flatMap((receipt) => [...libraryProjectionFiles(receipt)]),
    ),
  });
  if (
    source.length !== generated.length ||
    source.some((entry, index) => !hasSameTypeInput(entry, generated[index]))
  ) {
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

export function isValidTypeInputProjection(
  receipt: TypeInputProjectionReceipt,
  cache: NativeAnalysisCache,
  files?: ReadonlyMap<string, string>,
): boolean {
  if (
    ![
      receipt.scope === 'config-type-directives',
      receipt.version === 4,
      receipt.compilerVersion === ts.version,
    ].every(Boolean)
  )
    return false;
  const source = collectConfigTypeInputs({
    compiler: ts,
    configPath: receipt.sourceConfig,
    options: receipt.sourceOptions,
    cache,
  });
  const generated = collectConfigTypeInputs({
    compiler: ts,
    configPath: receipt.generatedConfig,
    options: receipt.generatedOptions,
    cache,
    files,
  });
  return (
    JSON.stringify(source) === JSON.stringify(receipt.source) &&
    JSON.stringify(generated) === JSON.stringify(receipt.generated)
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
