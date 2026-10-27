import path from 'pathe';
import ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import {
  collectConfigTypeInputs,
  type EffectiveTypeInput,
} from './config-type-inputs';
import { libraryProjectionFiles } from './library-projection';
import type { SourceProject } from './types';

export interface TypeInputProjectionReceipt {
  scope: 'config-type-directives';
  version: 2;
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
  return effectiveCompilerOptions({
    ...effectiveCompilerOptions(project.options),
    ...compiler.convertCompilerOptionsFromJson(
      overrides,
      path.dirname(generatedConfig),
      generatedConfig,
    ).options,
    configFilePath: generatedConfig,
  });
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
    shouldPinTypeInput(entry, generated[index]) ? entry.target! : entry.name,
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
    source.some((entry, index) => entry.target !== generated[index]?.target)
  ) {
    throw new Error(
      `Type input projection cannot preserve config-type-directives:\n  source: ${project.configPath}\n  generated: ${generatedConfig}\n  source entries: ${JSON.stringify(source)}\n  generated entries: ${JSON.stringify(generated)}`,
    );
  }
  return {
    scope: 'config-type-directives',
    version: 2,
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
      receipt.version === 2,
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
  return entry.target !== null && entry.target !== generated?.target;
}
