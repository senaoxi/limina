import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { nativeCompilerApi } from './native-program-api';

/**
Decorate an existing compiler request; never synthesize a request ourselves.
*/
interface SyntheticRequest {
  compiler: typeof ts;
  options: ts.CompilerOptions;
  configPath: string;
  source: ts.SourceFile;
  literal: ts.StringLiteralLike;
  mode: ts.ResolutionMode;
}
export function syntheticModuleMetadata(
  input: SyntheticRequest,
): Pick<ImportRecord, 'kind' | 'configurationSource'> {
  const api = nativeCompilerApi(input.compiler);
  const options = input.options;
  const runtime = api.getJSXRuntimeImport(
    api.getJSXImplicitImportBase(options, input.source),
    options,
  );
  return input.literal.text === runtime
    ? jsxMetadata(input)
    : { kind: 'environment-pragma' };
}

function jsxMetadata(
  input: SyntheticRequest,
): Pick<ImportRecord, 'kind' | 'configurationSource'> {
  const source = input.source as ts.SourceFile & {
    pragmas?: ReadonlyMap<string, unknown>;
  };
  if (source.pragmas?.has('jsximportsource'))
    return { kind: 'jsx-import-source' };
  return {
    kind: 'jsx-import-source',
    configurationSource: {
      configPath: input.configPath,
      option: 'jsxImportSource',
      resolutionMode: input.mode,
    },
  };
}
