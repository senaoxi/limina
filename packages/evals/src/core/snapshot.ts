import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

export type SnapshotEntry =
  | {
      path: string;
      kind: 'file';
      mode: number;
      sha256: string;
      content: string;
    }
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'symlink'; mode: number; target: string };

export interface Snapshot {
  version: 1;
  stage: 'F0' | 'S0' | 'S1';
  status: 'complete' | 'partial' | 'unknown';
  entries: SnapshotEntry[];
  excludedRoots: string[];
  digest: string | null;
  errors: { path: string; code: string }[];
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertRelativePath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^[a-z]:/i.test(path)
  ) {
    throw new Error('Non-canonical snapshot path');
  }
}

function digestEntries(
  entries: SnapshotEntry[],
  excludedRoots: string[],
): string {
  return sha256(JSON.stringify({ entries, excludedRoots }));
}

function isUnchanged(
  a: Awaited<ReturnType<typeof lstat>>,
  b: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

async function captureFile(
  absolute: string,
  relative: string,
  before: Stats,
  entries: SnapshotEntry[],
): Promise<void> {
  const mode = before.mode & 0o7777;
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!isUnchanged(before, await handle.stat()))
      throw new Error('FILE_CHANGED');
    const content = await handle.readFile();
    if (!isUnchanged(before, await handle.stat()))
      throw new Error('FILE_CHANGED');
    entries.push({
      path: relative,
      kind: 'file',
      mode,
      sha256: sha256(content),
      content: content.toString('base64'),
    });
  } finally {
    await handle.close();
  }
}

/** Run only in the protected collector, after the controller quiesces writers.
 * A local filesystem capture does not itself prove Sandbox isolation.
 */
export async function captureSnapshot(
  root: string,
  stage: Snapshot['stage'],
  options: {
    excludedRoots?: string[];
    maxBytes?: number;
    maxEntries?: number;
  } = {},
): Promise<Snapshot> {
  const excludedRoots = (options.excludedRoots ?? []).toSorted(comparePaths);
  for (const path of excludedRoots) assertRelativePath(path);
  const entries: SnapshotEntry[] = [];
  const errors: Snapshot['errors'] = [];
  let bytes = 0;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 10_000;
  async function visit(relative: string): Promise<void> {
    if (
      excludedRoots.some(
        (excluded) =>
          relative === excluded || relative.startsWith(`${excluded}/`),
      )
    )
      return;
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    try {
      if (relative) assertRelativePath(relative);
      if (entries.length >= maxEntries) throw new Error('ENTRY_LIMIT');
      const before = await lstat(absolute);
      const mode = before.mode & 0o7777;
      if (before.isSymbolicLink()) {
        if (!relative) throw new Error('ROOT_SYMLINK');
        entries.push({
          path: relative,
          kind: 'symlink',
          mode,
          target: await readlink(absolute),
        });
      } else if (before.isDirectory()) {
        if (relative) entries.push({ path: relative, kind: 'directory', mode });
        const names = await readdir(absolute);
        const children = names.toSorted(comparePaths);
        if (children.length + entries.length > maxEntries)
          throw new Error('ENTRY_LIMIT');
        for (const child of children)
          await visit(relative ? `${relative}/${child}` : child);
      } else if (relative && before.isFile()) {
        bytes += before.size;
        if (bytes > maxBytes) throw new Error('BYTE_LIMIT');
        await captureFile(absolute, relative, before, entries);
      } else {
        throw new Error('UNSUPPORTED_FILE_TYPE');
      }
      if (!isUnchanged(before, await lstat(absolute)))
        throw new Error('FILE_CHANGED');
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String(error.code)
          : error instanceof Error
            ? error.message
            : 'CAPTURE_FAILED';
      errors.push({ path: relative, code });
    }
  }
  await visit('');
  const sortedEntries = entries.toSorted((a, b) =>
    comparePaths(a.path, b.path),
  );
  const status =
    errors.length === 0
      ? 'complete'
      : entries.length > 0
        ? 'partial'
        : 'unknown';
  return {
    version: 1,
    stage,
    status,
    entries: sortedEntries,
    excludedRoots,
    digest:
      status === 'complete'
        ? digestEntries(sortedEntries, excludedRoots)
        : null,
    errors,
  };
}

function verifyEntryMetadata(entry: SnapshotEntry): void {
  if (
    !['file', 'directory', 'symlink'].includes(entry.kind) ||
    !Number.isSafeInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o7777
  )
    throw new Error('Invalid snapshot entry');
  if (
    entry.kind === 'symlink' &&
    (typeof entry.target !== 'string' || entry.target.includes('\0'))
  )
    throw new Error('Invalid symlink target');
}

// Recompute transport integrity at the controller; never trust a remote hash.
export function verifySnapshot(snapshot: Snapshot): void {
  if (
    snapshot.version !== 1 ||
    snapshot.status !== 'complete' ||
    snapshot.errors.length > 0 ||
    !snapshot.digest
  )
    throw new Error('Incomplete snapshot evidence');
  let previous: string | undefined;
  for (const path of snapshot.excludedRoots) assertRelativePath(path);
  for (const entry of snapshot.entries) {
    assertRelativePath(entry.path);
    verifyEntryMetadata(entry);
    if (
      snapshot.excludedRoots.some(
        (root) => entry.path === root || entry.path.startsWith(`${root}/`),
      )
    )
      throw new Error('Entry outside capture scope');
    if (previous !== undefined && comparePaths(entry.path, previous) <= 0)
      throw new Error('Duplicate or unsorted snapshot path');
    previous = entry.path;
    if (entry.kind !== 'file') continue;
    const bytes = Buffer.from(entry.content, 'base64');
    if (
      bytes.toString('base64') !== entry.content ||
      sha256(bytes) !== entry.sha256
    )
      throw new Error('Snapshot content mismatch');
  }
  if (
    digestEntries(snapshot.entries, snapshot.excludedRoots) !== snapshot.digest
  )
    throw new Error('Snapshot digest mismatch');
}

export interface FileChange {
  path: string;
  before?: SnapshotEntry;
  after?: SnapshotEntry;
}

export function compareAgentSnapshots(
  start: Snapshot,
  final: Snapshot,
): FileChange[] {
  verifySnapshot(start);
  verifySnapshot(final);
  if (start.stage !== 'S0' || final.stage !== 'S1')
    throw new Error('Agent evidence requires S0 and S1');
  if (
    JSON.stringify(start.excludedRoots) !== JSON.stringify(final.excludedRoots)
  )
    throw new Error('Capture scope changed');
  const before = new Map(start.entries.map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));
  const changes: FileChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].toSorted(
    comparePaths,
  )) {
    const prior = before.get(path);
    const next = after.get(path);
    if (JSON.stringify(prior) !== JSON.stringify(next))
      changes.push({
        path,
        ...(prior && { before: prior }),
        ...(next && { after: next }),
      });
  }
  return changes;
}
