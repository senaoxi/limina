import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

const TAB_STOP_COLUMNS = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export interface TerminalPosition {
  column: number;
  rowsAdvanced: number;
}

function advanceColumns(
  position: TerminalPosition,
  width: number,
  columns: number,
): void {
  if (width <= 0) {
    return;
  }

  if (position.column > 0 && position.column + width > columns) {
    position.rowsAdvanced += 1;
    position.column = 0;
  }

  position.column += width;

  while (position.column >= columns) {
    position.rowsAdvanced += 1;
    position.column -= columns;
  }
}

export function stripTerminalControlSequences(text: string): string {
  return stripVTControlCharacters(text).replaceAll('\r', '');
}

export function advanceTerminalPosition(
  text: string,
  columns: number,
  initialColumn = 0,
): TerminalPosition {
  const normalizedColumns = Math.max(1, columns);
  const position: TerminalPosition = {
    column: Math.max(0, initialColumn) % normalizedColumns,
    rowsAdvanced: Math.floor(Math.max(0, initialColumn) / normalizedColumns),
  };
  const visibleText = stripTerminalControlSequences(text);

  for (const { segment } of graphemeSegmenter.segment(visibleText)) {
    if (segment === '\n') {
      position.rowsAdvanced += 1;
      position.column = 0;
      continue;
    }

    if (segment === '\t') {
      advanceColumns(
        position,
        TAB_STOP_COLUMNS - (position.column % TAB_STOP_COLUMNS),
        normalizedColumns,
      );
      continue;
    }

    advanceColumns(position, stringWidth(segment), normalizedColumns);
  }

  return position;
}

type TerminalControlSequenceState =
  | 'control-string'
  | 'control-string-escape'
  | 'csi'
  | 'escape'
  | 'text';

export class TerminalTextStream {
  #decoder = new TextDecoder();
  #state: TerminalControlSequenceState = 'text';

  decode(chunk: string | Uint8Array): string {
    const text =
      typeof chunk === 'string'
        ? `${this.#decoder.decode()}${chunk}`
        : this.#decoder.decode(chunk, { stream: true });
    let visibleText = '';

    for (const character of text) {
      switch (this.#state) {
        case 'control-string': {
          if (character === '\u0007') {
            this.#state = 'text';
          } else if (character === '\u001B') {
            this.#state = 'control-string-escape';
          }
          break;
        }
        case 'control-string-escape': {
          this.#state = character === '\\' ? 'text' : 'control-string';
          break;
        }
        case 'csi': {
          if (/^[\u0040-\u007E]$/u.test(character)) {
            this.#state = 'text';
          }
          break;
        }
        case 'escape': {
          if (character === '[') {
            this.#state = 'csi';
          } else if (
            character === ']' ||
            character === 'P' ||
            character === 'X' ||
            character === '^' ||
            character === '_'
          ) {
            this.#state = 'control-string';
          } else {
            this.#state = 'text';
          }
          break;
        }
        case 'text': {
          if (character === '\u001B') {
            this.#state = 'escape';
          } else if (character !== '\r') {
            visibleText += character;
          }
          break;
        }
      }
    }

    return visibleText;
  }

  reset(): void {
    this.#decoder = new TextDecoder();
    this.#state = 'text';
  }
}
