import { renderCompactSnapshotLines, renderSnapshotLines } from './snapshot';
import { fitRenderedLinesToTerminal, fitsRenderedLines } from './terminal-fit';
import type { FlowRenderSnapshot, FlowTerminalDimensions } from './types';

export {
  fitRenderedLinesToTerminal,
  fitsRenderedLines,
  type FitRenderedLinesOptions,
} from './terminal-fit';

function shouldPreferCompact(snapshot: FlowRenderSnapshot): boolean {
  return (
    snapshot.compactMode === 'check-flow' && snapshot.outroMessage !== undefined
  );
}

function canRenderFullSnapshot(options: {
  dimensions: FlowTerminalDimensions;
  fullLines: readonly string[];
  preferCompact: boolean;
}): boolean {
  return (
    !options.preferCompact &&
    fitsRenderedLines(options.fullLines, options.dimensions, {
      reserveContext: true,
    })
  );
}

export function renderSnapshotLinesForTerminal(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
  dimensions: FlowTerminalDimensions,
): string[] {
  const fullLines = renderSnapshotLines(snapshot, spinnerFrameIndex);

  if (
    canRenderFullSnapshot({
      dimensions,
      fullLines,
      preferCompact: shouldPreferCompact(snapshot),
    })
  ) {
    return fullLines;
  }

  const compactLines = renderCompactSnapshotLines(snapshot, spinnerFrameIndex);
  return fitRenderedLinesToTerminal(compactLines, dimensions, {
    omittedLines: compactLines.length < fullLines.length,
  });
}
