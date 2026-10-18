import type ts from 'typescript';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
} from './records';
function getLineOffset(value: number | undefined): number {
  return value ?? 0;
}
export function collectReferenceDirectives(options: {
  filePath: string;
  sourceText: string;
  tsModule: typeof ts;
  lineOffset?: number;
  sourceOffset?: number;
}): CollectedImportRecord[] {
  const records: CollectedImportRecord[] = [];
  const parsed = options.tsModule.preProcessFile(
    options.sourceText,
    false,
    false,
  );
  for (const [kind, references] of [
    ['triple-slash-path', parsed.referencedFiles],
    ['triple-slash-types', parsed.typeReferenceDirectives],
  ] as const) {
    for (const reference of references)
      records.push(
        createImportRecord({
          filePath: options.filePath,
          kind,
          specifier: reference.fileName,
          pos: reference.pos - 1,
          end: reference.end + 1,
          lineOffset: getLineOffset(options.lineOffset),
          sourceOffset: getLineOffset(options.sourceOffset),
          lineStarts: buildLineStarts(options.sourceText),
        }),
      );
  }
  return records;
}
