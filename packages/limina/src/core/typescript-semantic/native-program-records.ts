import ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';
import { compilerModuleRecord } from './compiler-module-record';
import type { NativeObservationAdapter } from './native-observation-adapter';
import type { NativeModuleObservation } from './native-program-requests';
import { syntheticModuleMetadata } from './native-program-synthetic';

export interface NativeRequestRecord {
  readonly record: ImportRecord;
  readonly request: NativeRequest;
}

/**
Locations decorate the compiler's inventory; they never discover requests.
*/
export function nativeProgramRecords(
  adapter: NativeObservationAdapter,
): NativeRequestRecord[] {
  const modules = new Map(
    adapter.modules.map((item) => [item.requestId, item]),
  );
  const occurrences = new Map<string, number>();
  return adapter.snapshot.requests.flatMap((request) => {
    const record = requestRecord(adapter, request, modules.get(request.id));
    if (record === undefined) return [];
    const key = JSON.stringify([
      record.filePath,
      record.kind,
      record.specifier,
    ]);
    record.locator.occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, record.locator.occurrence + 1);
    return [{ request, record }];
  });
}

function requestRecord(
  adapter: NativeObservationAdapter,
  request: NativeRequest,
  module: NativeModuleObservation | undefined,
): ImportRecord | undefined {
  return module === undefined
    ? directiveRecord(adapter, request)
    : moduleRecord(adapter, module);
}

function moduleRecord(
  adapter: NativeObservationAdapter,
  module: NativeModuleObservation,
): ImportRecord {
  return {
    ...compilerModuleRecord(module.source, module.literal, module.role, ts),
    ...(module.literal.pos < 0 &&
      syntheticModuleMetadata({
        ...module,
        compiler: ts,
        options: adapter.program.getCompilerOptions(),
        configPath: adapter.options.project.configPath,
      })),
  };
}

function directiveRecord(
  adapter: NativeObservationAdapter,
  request: NativeRequest,
): ImportRecord | undefined {
  if (request.entry.kind !== 'source') return undefined;
  const source = adapter.program.getSourceFile(request.entry.file.lexicalPath);
  if (source === undefined) return undefined;
  const { position } = request.entry;
  return {
    domain: 'typescript',
    filePath: request.entry.file.lexicalPath,
    kind: directiveKind(request.channel),
    line: source.getLineAndCharacterOfPosition(position).line + 1,
    locator: {
      sourceStart: position,
      sourceEnd: position + request.specifier.length,
      occurrence: 0,
    },
    specifier: request.specifier,
  };
}

function directiveKind(channel: NativeRequest['channel']): ImportRecordKind {
  const kinds: Partial<Record<NativeRequest['channel'], ImportRecordKind>> = {
    'path-directive': 'triple-slash-path',
    'type-directive': 'triple-slash-types',
    library: 'environment-pragma',
  };
  return kinds[channel] ?? 'environment-pragma';
}
