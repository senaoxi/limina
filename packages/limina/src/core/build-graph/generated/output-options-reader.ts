import type { ResolvedLiminaConfig } from '#config/runner';
import { type JsonObject, readJsonConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { readExplicitSourceCompilerTarget } from './compiler-target';
import type {
  OutputOptions,
  OutputOptionsProblem,
} from './config-reader-types';
import {
  type OutputReaderContext,
  type OutputStringField,
  readDeclarationMap,
  readStringOutputFields,
  resolveOutputRecord,
  validateAllowedFields,
} from './output-options-validation';

function resolveOutputTarget(options: {
  config: ResolvedLiminaConfig;
  configuredTarget: string | undefined;
  sourceConfigPath: string;
}): string {
  if (options.configuredTarget !== undefined) {
    return options.configuredTarget;
  }

  return (
    readExplicitSourceCompilerTarget({
      config: options.config,
      configPath: options.sourceConfigPath,
    }) ?? 'ESNext'
  );
}

function resolveOutputPath(
  sourceDirectory: string,
  configuredPath: string | undefined,
  fallbackPath: string,
): string {
  return normalizeAbsolutePath(
    path.resolve(sourceDirectory, configuredPath ?? fallbackPath),
  );
}

function createOutputOptions(options: {
  config: ResolvedLiminaConfig;
  declarationMap: boolean;
  sourceConfigPath: string;
  values: Partial<Record<OutputStringField, string>>;
}): OutputOptions {
  const sourceDirectory = path.dirname(options.sourceConfigPath);
  return {
    declarationMap: options.declarationMap,
    outDir: resolveOutputPath(sourceDirectory, options.values.outDir, './dist'),
    rootDir: resolveOutputPath(sourceDirectory, options.values.rootDir, '.'),
    target: resolveOutputTarget({
      config: options.config,
      configuredTarget: options.values.target,
      sourceConfigPath: options.sourceConfigPath,
    }),
  };
}

function createEmptyResult(context: OutputReaderContext): {
  diagnostics: OutputOptionsProblem[];
  outputs: null;
  problems: string[];
} {
  return {
    diagnostics: context.diagnostics,
    outputs: null,
    problems: context.problems,
  };
}

function createOutputResult(options: {
  context: OutputReaderContext;
  declarationMap: boolean;
  values: Partial<Record<OutputStringField, string>>;
}): {
  diagnostics: OutputOptionsProblem[];
  outputs: OutputOptions | null;
  problems: string[];
} {
  return {
    diagnostics: options.context.diagnostics,
    outputs:
      options.context.problems.length === 0
        ? createOutputOptions({
            config: options.context.config,
            declarationMap: options.declarationMap,
            sourceConfigPath: options.context.sourceConfigPath,
            values: options.values,
          })
        : null,
    problems: options.context.problems,
  };
}

export function readOutputOptions(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
  configObject: JsonObject = readJsonConfig(config, sourceConfigPath),
): {
  diagnostics: OutputOptionsProblem[];
  outputs: OutputOptions | null;
  problems: string[];
} {
  const context: OutputReaderContext = {
    config,
    diagnostics: [],
    problems: [],
    sourceConfigPath,
  };
  const outputRecord = resolveOutputRecord(configObject, context);
  if (outputRecord.kind !== 'value') {
    return createEmptyResult(context);
  }

  validateAllowedFields(outputRecord.value, context);
  return createOutputResult({
    context,
    declarationMap: readDeclarationMap(outputRecord.value, context),
    values: readStringOutputFields(outputRecord.value, context),
  });
}
