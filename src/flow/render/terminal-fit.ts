import { advanceTerminalPosition } from '../terminal-position';
import type {
  FitRenderedLinesOptions,
  TerminalFitPlan,
} from './terminal-fit-types';
import type { FlowTerminalDimensions } from './types';

export type { FitRenderedLinesOptions } from './terminal-fit-types';
const DEFAULT_TERMINAL_COLUMNS = 80;
const TERMINAL_FRAME_MARGIN_LINES = 1;
const TERMINAL_FRAME_CONTEXT_LINES = 6;
const OMITTED_LINES_MARKER = '│  ...';
function getTerminalColumns(dimensions: FlowTerminalDimensions): number {
  return Math.max(1, dimensions.columns ?? DEFAULT_TERMINAL_COLUMNS);
}

function getTerminalRows(dimensions: FlowTerminalDimensions): number {
  return dimensions.rows ?? 0;
}

function countRenderedTerminalRows(line: string, columns: number): number {
  return advanceTerminalPosition(line, columns).rowsAdvanced + 1;
}

function countRenderedRows(
  lines: readonly string[],
  dimensions: FlowTerminalDimensions,
): number {
  const columns = getTerminalColumns(dimensions);
  return lines.reduce(
    (sum, line) => sum + countRenderedTerminalRows(line, columns),
    0,
  );
}

function getReservedContextLines(options: {
  dimensions: FlowTerminalDimensions;
  reserveContext: boolean;
}): number {
  if (!options.reserveContext) {
    return 0;
  }

  if (getTerminalRows(options.dimensions) <= TERMINAL_FRAME_CONTEXT_LINES * 2) {
    return 0;
  }

  return TERMINAL_FRAME_CONTEXT_LINES;
}

export function fitsRenderedLines(
  lines: readonly string[],
  dimensions: FlowTerminalDimensions,
  options: { reserveContext?: boolean } = {},
): boolean {
  if (dimensions.rows === undefined) {
    return true;
  }

  const contextLines = getReservedContextLines({
    dimensions,
    reserveContext: options.reserveContext === true,
  });
  const lineLimit = Math.max(
    1,
    dimensions.rows - TERMINAL_FRAME_MARGIN_LINES - contextLines,
  );
  return countRenderedRows(lines, dimensions) <= lineLimit;
}

function isOutroLine(line: string | undefined): boolean {
  return line !== undefined && line.startsWith('└  ');
}

function addOmittedLinesMarker(lines: string[]): string[] {
  if (lines.includes(OMITTED_LINES_MARKER)) {
    return lines;
  }

  const lastLine = lines.at(-1);

  if (isOutroLine(lastLine)) {
    return [...lines.slice(0, -1), OMITTED_LINES_MARKER, lastLine!];
  }

  return [...lines, OMITTED_LINES_MARKER];
}

function shouldReturnOriginal(options: {
  dimensions: FlowTerminalDimensions;
  fitOptions: FitRenderedLinesOptions;
  lines: readonly string[];
}): boolean {
  return (
    fitsRenderedLines(options.lines, options.dimensions) &&
    options.fitOptions.omittedLines !== true
  );
}

function fitWithoutRowLimit(
  lines: string[],
  options: FitRenderedLinesOptions,
): string[] {
  return options.omittedLines === true ? addOmittedLinesMarker(lines) : lines;
}

function getReservedOutroRows(options: {
  columns: number;
  lastLine: string | undefined;
  preserveOutro: boolean;
}): number {
  if (!options.preserveOutro) {
    return 0;
  }

  if (options.lastLine === undefined) {
    return 0;
  }

  return countRenderedTerminalRows(options.lastLine, options.columns);
}

function shouldShowOmissionMarker(options: {
  availableBodyRows: number;
  bodyRows: number;
  ellipsisRows: number;
  omittedLines: boolean;
}): boolean {
  const needsMarker =
    options.omittedLines || options.bodyRows > options.availableBodyRows;
  return needsMarker && options.availableBodyRows >= options.ellipsisRows;
}

function createTerminalFitPlan(options: {
  dimensions: FlowTerminalDimensions;
  fitOptions: FitRenderedLinesOptions;
  lines: readonly string[];
}): TerminalFitPlan {
  const lineLimit = Math.max(
    1,
    getTerminalRows(options.dimensions) - TERMINAL_FRAME_MARGIN_LINES,
  );
  const columns = getTerminalColumns(options.dimensions);
  const lastLine = options.lines.at(-1);
  const preserveOutro = isOutroLine(lastLine);
  const bodyLineCount = options.lines.length - Number(preserveOutro);
  const bodyLines = options.lines.slice(0, bodyLineCount);
  const ellipsisRows = countRenderedTerminalRows(OMITTED_LINES_MARKER, columns);
  const reservedRows = getReservedOutroRows({
    columns,
    lastLine,
    preserveOutro,
  });
  const availableBodyRows = Math.max(0, lineLimit - reservedRows);
  const bodyRows = countRenderedRows(bodyLines, { columns });
  const showOmissionMarker = shouldShowOmissionMarker({
    availableBodyRows,
    bodyRows,
    ellipsisRows,
    omittedLines: options.fitOptions.omittedLines === true,
  });
  return {
    availableBodyRows,
    bodyLineCount,
    columns,
    ellipsisRows,
    lastLine,
    lineLimit,
    preserveOutro,
    reservedRows,
    showOmissionMarker,
  };
}

function getInitialBodyRows(plan: TerminalFitPlan): number {
  return plan.showOmissionMarker
    ? plan.availableBodyRows - plan.ellipsisRows
    : plan.availableBodyRows;
}

function appendBodyLine(options: {
  fittedLines: string[];
  line: string;
  plan: TerminalFitPlan;
  remainingRows: number;
}): number | null {
  const rowCount = countRenderedTerminalRows(
    options.line,
    options.plan.columns,
  );

  if (rowCount > options.remainingRows) {
    return null;
  }

  options.fittedLines.push(options.line);
  return options.remainingRows - rowCount;
}

function collectFittedBodyLines(options: {
  lines: readonly string[];
  plan: TerminalFitPlan;
}): string[] {
  const fittedLines: string[] = [];
  let remainingRows = getInitialBodyRows(options.plan);

  for (let index = 0; index < options.plan.bodyLineCount; index += 1) {
    const nextRemainingRows = appendBodyLine({
      fittedLines,
      line: options.lines[index]!,
      plan: options.plan,
      remainingRows,
    });

    if (nextRemainingRows === null) {
      break;
    }

    remainingRows = nextRemainingRows;
  }

  return fittedLines;
}

function appendOmissionMarker(lines: string[], plan: TerminalFitPlan): void {
  if (plan.showOmissionMarker) {
    lines.push(OMITTED_LINES_MARKER);
  }
}

function canAppendOutro(plan: TerminalFitPlan): boolean {
  if (!plan.preserveOutro) {
    return false;
  }

  if (plan.lastLine === undefined) {
    return false;
  }

  return plan.reservedRows <= plan.lineLimit;
}

function appendPreservedOutro(lines: string[], plan: TerminalFitPlan): void {
  if (canAppendOutro(plan)) {
    lines.push(plan.lastLine!);
  }
}

function finalizeFittedLines(
  fittedLines: string[],
  sourceLines: readonly string[],
): string[] {
  return fittedLines.length > 0 ? fittedLines : sourceLines.slice(0, 1);
}

function getImmediateFitResult(options: {
  dimensions: FlowTerminalDimensions;
  fitOptions: FitRenderedLinesOptions;
  lines: string[];
}): string[] | null {
  if (shouldReturnOriginal(options)) {
    return options.lines;
  }

  if (options.dimensions.rows === undefined) {
    return fitWithoutRowLimit(options.lines, options.fitOptions);
  }

  return null;
}

function fitWithRowLimit(options: {
  dimensions: FlowTerminalDimensions;
  fitOptions: FitRenderedLinesOptions;
  lines: string[];
}): string[] {
  const plan = createTerminalFitPlan(options);
  const fittedLines = collectFittedBodyLines({ lines: options.lines, plan });
  appendOmissionMarker(fittedLines, plan);
  appendPreservedOutro(fittedLines, plan);
  return finalizeFittedLines(fittedLines, options.lines);
}

export function fitRenderedLinesToTerminal(
  lines: string[],
  dimensions: FlowTerminalDimensions,
  options: FitRenderedLinesOptions = {},
): string[] {
  const immediate = getImmediateFitResult({
    dimensions,
    fitOptions: options,
    lines,
  });

  if (immediate !== null) {
    return immediate;
  }

  return fitWithRowLimit({ dimensions, fitOptions: options, lines });
}
