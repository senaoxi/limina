import path from 'pathe';
import { normalizeAbsolutePath } from './path';

/** Lexical traversal for config and nearest-manifest discovery only. */
export function* ancestorDirectories(startDir: string): Generator<string> {
  let directory = normalizeAbsolutePath(startDir);
  while (true) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
