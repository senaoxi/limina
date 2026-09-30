import type { Dirent, readdir } from 'node:fs';
import { readdir as readEntries, realpath, stat } from 'node:fs/promises';
import path from 'pathe';

async function isAncestorTarget(
  directory: string,
  target: string,
): Promise<boolean> {
  if ((await realpath(directory)) === target) return true;
  const parent = path.dirname(directory);
  return parent !== directory && isAncestorTarget(parent, target);
}

function directoryEntry(entry: Dirent, isDirectory: boolean): Dirent {
  return new Proxy(entry, {
    get(target, property) {
      if (property === 'isDirectory') return () => isDirectory;
      return property === 'isSymbolicLink'
        ? () => false
        : Reflect.get(target, property);
    },
  });
}

async function lexicalEntry(
  directory: string,
  entry: Dirent,
  cycleDirectories: Set<string>,
): Promise<Dirent> {
  if (!entry.isSymbolicLink()) return entry;
  const lexicalPath = path.join(directory, entry.name);
  const target = await realpath(lexicalPath);
  if (!(await stat(target)).isDirectory()) return entry;
  await recordAncestorCycle({
    directory,
    target,
    lexicalPath,
    cycleDirectories,
  });
  return directoryEntry(entry, true);
}

async function recordAncestorCycle(options: {
  directory: string;
  target: string;
  lexicalPath: string;
  cycleDirectories: Set<string>;
}): Promise<void> {
  if (await isAncestorTarget(options.directory, options.target)) {
    options.cycleDirectories.add(path.resolve(options.lexicalPath));
  }
}

async function lexicalEntries(
  directory: string,
  cycleDirectories: Set<string>,
): Promise<Dirent[]> {
  if (cycleDirectories.has(path.resolve(directory))) return [];
  const entries = await readEntries(directory, { withFileTypes: true });
  return Promise.all(
    entries.map((entry) =>
      readableLexicalEntry(directory, entry, cycleDirectories),
    ),
  );
}

/** fdir omits the symlink directory itself from onlyDirectories results.
 * Present directory links as directories, retaining aliases and guarding only
 * ancestor cycles; sibling aliases must reach physical-identity validation.
 */
export function createLexicalDirectoryFs(): { readdir: typeof readdir } {
  const cycleDirectories = new Set<string>();
  return {
    readdir: ((
      directory: string,
      _options: unknown,
      callback: (error: unknown, entries?: Dirent[]) => void,
    ) => {
      readLexicalEntries(directory, cycleDirectories, callback);
    }) as typeof readdir,
  };
}

async function readLexicalEntries(
  directory: string,
  cycleDirectories: Set<string>,
  callback: (error: unknown, entries?: Dirent[]) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await lexicalEntries(directory, cycleDirectories);
  } catch (error) {
    callback(error);
    return;
  }
  callback(null, entries);
}

async function readableLexicalEntry(
  directory: string,
  entry: Dirent,
  cycleDirectories: Set<string>,
): Promise<Dirent> {
  try {
    return await lexicalEntry(directory, entry, cycleDirectories);
  } catch (error) {
    if (isMissingLink(error)) return directoryEntry(entry, false);
    throw error;
  }
}

function isMissingLink(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
  );
}
