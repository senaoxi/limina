import type { TerminalChunk } from './terminal-frames';

// Replace capture-machine paths before the terminal can wrap them across rows.
// A PTY read may split a path at any byte; match against the complete stream,
// then emit replacements when their final input chunk arrives.
export function publicTerminalChunks(
  chunks: readonly TerminalChunk[],
  paths: ReadonlyMap<string, string>,
): TerminalChunk[] {
  const raw = chunks.map((chunk) => chunk.text).join('');
  const keys = paths
    .keys()
    .filter(Boolean)
    .toArray()
    .sort((a, b) => b.length - a.length);
  if (keys.length === 0) return chunks.map((chunk) => ({ ...chunk }));
  const expression = new RegExp(
    keys
      .map((key) => key.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
      .join('|'),
    'gu',
  );
  const matches = raw.matchAll(expression).toArray();
  const output: TerminalChunk[] = [];
  let position = 0;
  let limit = 0;
  let index = 0;
  for (const chunk of chunks) {
    limit += chunk.text.length;
    let text = '';
    let match = matches[index];
    while (match && match.index + match[0].length <= limit) {
      text += raw.slice(position, match.index) + paths.get(match[0])!;
      position = match.index + match[0].length;
      match = matches[++index];
    }
    const safeEnd = match && match.index < limit ? match.index : limit;
    text += raw.slice(position, safeEnd);
    position = safeEnd;
    if (text) output.push({ atMs: chunk.atMs, text });
  }
  return output;
}
