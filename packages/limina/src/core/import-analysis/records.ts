export type ImportRecordKind =
  | 'static'
  | 'export'
  | 'dynamic'
  | 'import-type'
  | 'commonjs'
  | 'require-resolve'
  | 'import-equals'
  | 'comment';

export interface ImportRecord {
  filePath: string;
  kind: ImportRecordKind;
  line: number;
  specifier: string;
}

export interface CollectedImportRecord extends ImportRecord {
  pos: number;
}

export function finalizeImportRecords(
  records: CollectedImportRecord[],
): ImportRecord[] {
  return records
    .map((record, index) => ({ index, record }))
    .sort(
      (left, right) =>
        left.record.pos - right.record.pos || left.index - right.index,
    )
    .map(({ record }) => ({
      filePath: record.filePath,
      kind: record.kind,
      line: record.line,
      specifier: record.specifier,
    }));
}

export function buildLineStarts(sourceText: string): number[] {
  const starts = [0];

  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText.codePointAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

export function getLine(lineStarts: number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;

    if (lineStarts[mid] <= pos) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low + 1;
}

export function createImportRecord(options: {
  filePath: string;
  kind: ImportRecordKind;
  lineOffset: number;
  lineStarts: number[];
  pos: number;
  sourceOffset: number;
  specifier: string;
}): CollectedImportRecord {
  return {
    filePath: options.filePath,
    kind: options.kind,
    line: options.lineOffset + getLine(options.lineStarts, options.pos),
    pos: options.sourceOffset + options.pos,
    specifier: options.specifier,
  };
}
