export type ImportRecordKind =
  | 'static'
  | 'export'
  | 'dynamic'
  | 'import-type'
  | 'commonjs'
  | 'require-resolve'
  | 'import-equals'
  | 'jsdoc-import'
  | 'triple-slash-path'
  | 'triple-slash-types'
  | 'jsx-import-source'
  | 'environment-pragma';

export interface ImportLocator {
  occurrence: number;
  sourceEnd: number;
  sourceStart: number;
}

export interface ImportRecord {
  filePath: string;
  kind: ImportRecordKind;
  line: number;
  locator: ImportLocator;
  specifier: string;
}

export interface CollectedImportRecord extends ImportRecord {
  pos: number;
}

export function finalizeImportRecords(
  records: CollectedImportRecord[],
): ImportRecord[] {
  const occurrenceByIdentity = new Map<string, number>();

  return records
    .map((record, index) => ({ index, record }))
    .sort(
      (left, right) =>
        left.record.pos - right.record.pos || left.index - right.index,
    )
    .map(({ record }) => {
      const identity = JSON.stringify([record.kind, record.specifier]);
      const occurrence = occurrenceByIdentity.get(identity) ?? 0;

      occurrenceByIdentity.set(identity, occurrence + 1);

      return {
        filePath: record.filePath,
        kind: record.kind,
        line: record.line,
        locator: {
          ...record.locator,
          occurrence,
        },
        specifier: record.specifier,
      };
    });
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
  end?: number;
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
    locator: {
      occurrence: 0,
      sourceEnd:
        options.sourceOffset +
        (options.end ?? options.pos + options.specifier.length),
      sourceStart: options.sourceOffset + options.pos,
    },
    pos: options.sourceOffset + options.pos,
    specifier: options.specifier,
  };
}
