import { normalizeAbsolutePath } from '#utils/path';
import { decodedMappings, type TraceMap } from '@jridgewell/trace-mapping';
import type { ImportRecord } from '../import-analysis/runner';

interface LineColumn {
  column: number;
  line: number;
}

interface SourceRange {
  end: number;
  start: number;
}

export type SvelteGeneratedRangeMapping =
  | { kind: 'mapped'; range: SourceRange }
  | { kind: 'source-map-mismatch'; reason: string }
  | { kind: 'unmapped' };

type DecodedSegment = readonly number[];

function offsetToLineColumn(
  lineStarts: readonly number[],
  offset: number,
): LineColumn {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { column: offset - lineStarts[low]!, line: low };
}

function lineColumnToOffset(
  lineStarts: readonly number[],
  line: number,
  column: number,
): number | null {
  const lineStart = lineStarts[line];
  if (lineStart === undefined) return null;
  return lineStart + column;
}

function findExactSegment(options: {
  column: number;
  line: number;
  mappings: ReturnType<typeof decodedMappings>;
}): DecodedSegment | null {
  const line = options.mappings[options.line];
  if (line === undefined) return null;
  return line.find((segment) => segment[0] === options.column) ?? null;
}

function isMappedSegment(
  segment: DecodedSegment | null,
): segment is readonly [number, number, number, number, ...number[]] {
  return segment !== null && segment.length >= 4;
}

function getExactMappedSegment(options: {
  column: number;
  line: number;
  mappings: ReturnType<typeof decodedMappings>;
}) {
  const segment = findExactSegment(options);
  if (!isMappedSegment(segment)) return null;
  return segment;
}

function mapsToCurrentSource(
  resolvedSource: string | undefined,
  sourceFilePath: string,
): boolean {
  if (resolvedSource === undefined) return false;
  return normalizeAbsolutePath(resolvedSource) === sourceFilePath;
}

function mapOriginalPosition(options: {
  segment: readonly [number, number, number, number, ...number[]];
  sourceLineStarts: readonly number[];
}):
  | { kind: 'mapped'; offset: number }
  | { kind: 'source-map-mismatch'; reason: string } {
  const originalOffset = lineColumnToOffset(
    options.sourceLineStarts,
    options.segment[2],
    options.segment[3],
  );
  return originalOffset === null
    ? {
        kind: 'source-map-mismatch',
        reason: 'Svelte dependency mapping referenced an invalid source line.',
      }
    : { kind: 'mapped', offset: originalOffset };
}

function mapSegmentToSource(options: {
  segment: readonly [number, number, number, number, ...number[]];
  sourceFilePath: string;
  sourceLineStarts: readonly number[];
  trace: TraceMap;
}):
  | { kind: 'mapped'; offset: number }
  | { kind: 'source-map-mismatch'; reason: string } {
  const resolvedSource = options.trace.resolvedSources[options.segment[1]];
  if (!mapsToCurrentSource(resolvedSource, options.sourceFilePath)) {
    return {
      kind: 'source-map-mismatch',
      reason: 'Svelte dependency mapping crossed into a different source file.',
    };
  }
  return mapOriginalPosition(options);
}

function mapExactOffset(options: {
  generatedLineStarts: readonly number[];
  mappings: ReturnType<typeof decodedMappings>;
  offset: number;
  sourceFilePath: string;
  sourceLineStarts: readonly number[];
  trace: TraceMap;
}):
  | { kind: 'mapped'; offset: number }
  | { kind: 'unmapped' }
  | { kind: 'source-map-mismatch'; reason: string } {
  const generated = offsetToLineColumn(
    options.generatedLineStarts,
    options.offset,
  );
  const segment = getExactMappedSegment({
    ...generated,
    mappings: options.mappings,
  });
  if (segment === null) return { kind: 'unmapped' };
  return mapSegmentToSource({ ...options, segment });
}

interface DenseOffsetState {
  offsets: number[];
  sawMapped: boolean;
  sawUnmapped: boolean;
}

function appendMappedOffset(
  state: DenseOffsetState,
  mapped: ReturnType<typeof mapExactOffset>,
): Extract<
  SvelteGeneratedRangeMapping,
  { kind: 'source-map-mismatch' }
> | null {
  if (mapped.kind === 'source-map-mismatch') return mapped;
  if (mapped.kind === 'unmapped') {
    state.sawUnmapped = true;
    return null;
  }
  state.sawMapped = true;
  state.offsets.push(mapped.offset);
  return null;
}

function finalizeDenseOffsets(
  state: DenseOffsetState,
): SvelteGeneratedRangeMapping | number[] {
  if (!state.sawMapped) return { kind: 'unmapped' };
  if (state.sawUnmapped) {
    return {
      kind: 'source-map-mismatch',
      reason:
        'Svelte dependency range was only partially covered by explicit source-map segments.',
    };
  }
  return state.offsets;
}

function collectDenseOffsets(options: {
  generatedLineStarts: readonly number[];
  generatedRecord: ImportRecord;
  sourceFilePath: string;
  sourceLineStarts: readonly number[];
  trace: TraceMap;
}): SvelteGeneratedRangeMapping | number[] {
  const mappings = decodedMappings(options.trace);
  const state: DenseOffsetState = {
    offsets: [],
    sawMapped: false,
    sawUnmapped: false,
  };
  for (
    let offset = options.generatedRecord.locator.sourceStart;
    offset < options.generatedRecord.locator.sourceEnd;
    offset += 1
  ) {
    const mapped = mapExactOffset({ ...options, mappings, offset });
    const failure = appendMappedOffset(state, mapped);
    if (failure !== null) return failure;
  }
  return finalizeDenseOffsets(state);
}

function validateOffsetPairs(offsets: readonly number[]): string | null {
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index]! - offsets[index - 1]! !== 1) {
      return 'Svelte dependency mapping was not monotonic and contiguous.';
    }
  }
  return null;
}

function validateContinuousOffsets(offsets: readonly number[]): string | null {
  if (offsets.length === 0) {
    return 'Svelte dependency mapping produced an empty source range.';
  }
  return validateOffsetPairs(offsets);
}

export function mapGeneratedRange(options: {
  generatedLineStarts: readonly number[];
  generatedRecord: ImportRecord;
  sourceFilePath: string;
  sourceLineStarts: readonly number[];
  trace: TraceMap;
}): SvelteGeneratedRangeMapping {
  const offsets = collectDenseOffsets(options);
  if (!Array.isArray(offsets)) return offsets;
  const reason = validateContinuousOffsets(offsets);
  if (reason !== null) return { kind: 'source-map-mismatch', reason };
  return {
    kind: 'mapped',
    range: { end: offsets.at(-1)! + 1, start: offsets[0]! },
  };
}
