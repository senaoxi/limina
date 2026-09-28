import {
  buildLineStarts,
  createImportRecord,
  type ImportRecord,
} from '../import-analysis/records';
import type { GeneratedSemanticDependency } from './generated-dependencies';

export type StrictBackprojection =
  | { kind: 'mapped'; sourceRecord: ImportRecord }
  | { kind: 'source-map-ambiguity' }
  | { kind: 'source-map-mismatch'; reason: string }
  | { kind: 'unmapped' };

interface SourceRange {
  end: number;
  start: number;
}

interface StrictSourceMapper {
  toSourceRange(
    start: number,
    end: number,
    fallbackToAnyMatch: boolean,
  ): Iterable<readonly [number, number, unknown, unknown]>;
}

function rangeIdentity(range: SourceRange): string {
  return JSON.stringify([range.start, range.end]);
}

function collectRanges(options: {
  end: number;
  mapper: StrictSourceMapper;
  start: number;
}): SourceRange[] {
  const byIdentity = new Map<string, SourceRange>();
  for (const [start, end] of options.mapper.toSourceRange(
    options.start,
    options.end,
    false,
  )) {
    const range = { end, start };
    byIdentity.set(rangeIdentity(range), range);
  }
  return [...byIdentity.values()];
}

function selectOrderedRanges(options: {
  dependency: GeneratedSemanticDependency;
  mapper: StrictSourceMapper;
}): SourceRange[] {
  const record = options.dependency.record;
  const full = collectRanges({
    end: record.locator.sourceEnd,
    mapper: options.mapper,
    start: record.locator.sourceStart,
  });
  if (full.length > 0) return full;
  return collectRanges({
    end: record.locator.sourceEnd - 1,
    mapper: options.mapper,
    start: record.locator.sourceStart + 1,
  });
}

function validateIntegerRange(range: SourceRange): string | null {
  if (![range.start, range.end].every(Number.isInteger)) {
    return 'Strict source-map projection returned non-integer source offsets.';
  }
  return null;
}

function validateOrderedRange(range: SourceRange): string | null {
  if (![range.start >= 0, range.end > range.start].every(Boolean)) {
    return 'Strict source-map projection returned an unordered source range.';
  }
  return null;
}

function validateContainedRange(
  range: SourceRange,
  sourceText: string,
): string | null {
  if (range.end > sourceText.length) {
    return 'Strict source-map projection escaped the current source snapshot.';
  }
  return null;
}

function validateRange(range: SourceRange, sourceText: string): string | null {
  return (
    [
      validateIntegerRange(range),
      validateOrderedRange(range),
      validateContainedRange(range, sourceText),
    ].find((reason) => reason !== null) ?? null
  );
}

function createSourceRecord(options: {
  dependency: GeneratedSemanticDependency;
  filePath: string;
  range: SourceRange;
  sourceText: string;
}): ImportRecord {
  const collected = createImportRecord({
    end: options.range.end,
    filePath: options.filePath,
    kind: options.dependency.record.kind,
    lineOffset: 0,
    lineStarts: buildLineStarts(options.sourceText),
    pos: options.range.start,
    sourceOffset: 0,
    specifier: options.dependency.record.specifier,
  });
  return {
    domain: collected.domain,
    filePath: collected.filePath,
    kind: collected.kind,
    line: collected.line,
    locator: collected.locator,
    specifier: collected.specifier,
  };
}

function classifyRanges(
  ranges: readonly SourceRange[],
): SourceRange | StrictBackprojection {
  if (ranges.length === 0) return { kind: 'unmapped' };
  if (ranges.length > 1) return { kind: 'source-map-ambiguity' };
  return ranges[0]!;
}

export function strictBackprojectVolarDependency(options: {
  dependency: GeneratedSemanticDependency;
  mapper: StrictSourceMapper;
  sourceFilePath: string;
  sourceText: string;
}): StrictBackprojection {
  const selected = classifyRanges(selectOrderedRanges(options));
  if ('kind' in selected) return selected;
  const range = selected;
  const reason = validateRange(range, options.sourceText);
  if (reason !== null) return { kind: 'source-map-mismatch', reason };
  return {
    kind: 'mapped',
    sourceRecord: createSourceRecord({
      dependency: options.dependency,
      filePath: options.sourceFilePath,
      range,
      sourceText: options.sourceText,
    }),
  };
}
