import path from 'pathe';
import { normalizeAbsolutePath } from './path';

/**
Lexical traversal for config and nearest-manifest discovery only.
*/
export function* ancestorDirectories(
  startDirectory: string,
): Generator<string> {
  let directory = normalizeAbsolutePath(startDirectory);
  while (true) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
