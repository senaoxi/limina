import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { NativeObservationAdapter } from './native-observation-adapter';
import { nativeCompilerApi } from './native-program-api';
import type { NativeModuleObservation } from './native-program-requests';

/**
Decorate an existing compiler request; never synthesize a request ourselves.
*/
export function syntheticModuleMetadata(
  adapter: NativeObservationAdapter,
  module: NativeModuleObservation,
): Pick<ImportRecord, 'kind' | 'configurationSource'> {
  const api = nativeCompilerApi(ts);
  const options = adapter.program.getCompilerOptions();
  const runtime = api.getJSXRuntimeImport(
    api.getJSXImplicitImportBase(options, module.source),
    options,
  );
  return module.literal.text === runtime
    ? jsxMetadata(adapter, module)
    : { kind: 'environment-pragma' };
}

function jsxMetadata(
  adapter: NativeObservationAdapter,
  module: NativeModuleObservation,
): Pick<ImportRecord, 'kind' | 'configurationSource'> {
  const source = module.source as ts.SourceFile & {
    pragmas?: ReadonlyMap<string, unknown>;
  };
  if (source.pragmas?.has('jsximportsource'))
    return { kind: 'jsx-import-source' };
  return {
    kind: 'jsx-import-source',
    configurationSource: {
      configPath: adapter.options.project.configPath,
      option: 'jsxImportSource',
      resolutionMode: module.mode,
    },
  };
}
