import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';
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
  const { literal, source } = module;
  const start = literal.pos < 0 ? -1 : literal.getStart(source);
  return {
    domain: 'typescript',
    filePath: normalizeAbsolutePath(source.fileName),
    kind: moduleKind(module),
    line: moduleLine(source, start),
    locator: { sourceStart: start, sourceEnd: literal.end, occurrence: 0 },
    specifier: literal.text,
    ...(start < 0 && syntheticModuleMetadata(adapter, module)),
  };
}

function moduleLine(source: ts.SourceFile, start: number): number {
  return start < 0 ? 1 : source.getLineAndCharacterOfPosition(start).line + 1;
}

function moduleKind(module: NativeModuleObservation): ImportRecordKind {
  if (module.role === 'augmentation') return 'module-augmentation';
  return module.literal.pos < 0
    ? 'environment-pragma'
    : literalKind(module.literal);
}

function literalKind(literal: ts.StringLiteralLike): ImportRecordKind {
  const parent = literal.parent;
  const kinds = new Map<number, ImportRecordKind>([
    [ts.SyntaxKind.ImportDeclaration, 'static'],
    [ts.SyntaxKind.ExportDeclaration, 'export'],
    [ts.SyntaxKind.ExternalModuleReference, 'import-equals'],
    [ts.SyntaxKind.LiteralType, 'import-type'],
    [ts.SyntaxKind.JSDocImportTag, 'jsdoc-import'],
  ]);
  return ts.isCallExpression(parent)
    ? callKind(parent)
    : (kinds.get(parent.kind) ?? 'static');
}

function callKind(call: ts.CallExpression): ImportRecordKind {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
    ? 'dynamic'
    : 'commonjs';
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
