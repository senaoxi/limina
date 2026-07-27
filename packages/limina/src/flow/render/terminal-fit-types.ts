export interface FitRenderedLinesOptions {
  omittedLines?: boolean;
}

export interface TerminalFitPlan {
  availableBodyRows: number;
  bodyLineCount: number;
  columns: number;
  ellipsisRows: number;
  lastLine: string | undefined;
  lineLimit: number;
  preserveOutro: boolean;
  reservedRows: number;
  showOmissionMarker: boolean;
}
