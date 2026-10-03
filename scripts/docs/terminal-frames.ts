import headless from '@xterm/headless';

export interface TerminalChunk {
  atMs: number;
  text: string;
}

export interface TerminalFrame {
  atMs: number;
  lines: string[];
}

// A PTY read can split a cursor movement or one redraw over several chunks.
// Coalesce adjacent writes before observing the screen; retain the raw capture.
export async function terminalFrames(
  chunks: readonly TerminalChunk[],
  columns: number,
  rows: number,
): Promise<TerminalFrame[]> {
  const terminal = new headless.Terminal({
    cols: columns,
    rows,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const writes: TerminalChunk[] = [];
  for (const chunk of chunks) {
    const previous = writes.at(-1);
    if (previous && chunk.atMs - previous.atMs <= 20) {
      previous.atMs = chunk.atMs;
      previous.text += chunk.text;
    } else writes.push({ ...chunk });
  }
  const frames: TerminalFrame[] = [];
  try {
    for (const write of writes) {
      await new Promise<void>((resolve) => terminal.write(write.text, resolve));
      const buffer = terminal.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)!.translateToString(true),
      );
      // Crop unused viewport padding, preserving all internal blank rows.
      while (lines[0] === '') lines.shift();
      while (lines.at(-1) === '') lines.pop();
      if (
        lines.length > 0 &&
        JSON.stringify(lines) !== JSON.stringify(frames.at(-1)?.lines)
      )
        frames.push({ atMs: write.atMs, lines });
    }
    return frames;
  } finally {
    terminal.dispose();
  }
}
