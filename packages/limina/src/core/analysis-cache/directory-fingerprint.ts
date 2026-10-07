import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'pathe';
import { AnalysisInputDriftError } from './contracts';
import { analysisHash } from './identity';

function optionalLstat(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return undefined;
    throw error;
  }
}
function entryKind(stat: Stats): string {
  const kinds = [
    ['link', stat.isSymbolicLink()],
    ['directory', stat.isDirectory()],
    ['file', stat.isFile()],
  ] as const;
  return kinds.find(([, applies]) => applies)?.[0] ?? 'other';
}
function recordLink(file: string, links: [string, string][]): void {
  if (optionalLstat(file)?.isSymbolicLink())
    links.push([file, readlinkSync(file)]);
}
function childNames(file: string): string[] {
  return readdirSync(file)
    .filter((entry) => entry !== 'node_modules')
    .sort(compareCodeUnits);
}
function inventoryEntry(relative: string, stat: Stats): unknown {
  return [relative, entryKind(stat), stat.isFile() ? stat.mtimeMs : null];
}
function linkBindings(file: string): [string, string][] {
  const links: [string, string][] = [];
  let cursor = normalizeAbsolutePath(file);
  while (true) {
    recordLink(cursor, links);
    const parent = path.dirname(cursor);
    if (parent === cursor) return links;
    cursor = parent;
  }
}
function physicalBinding(file: string): [string, string | null] {
  const stat = optionalLstat(file);
  return stat === undefined
    ? ['missing', null]
    : [entryKind(stat), normalizeAbsolutePath(realpathSync.native(file))];
}
export function pathBinding(file: string): unknown {
  return [file, ...physicalBinding(file), linkBindings(file)];
}
class LocalInventory {
  readonly entries: unknown[] = [];
  readonly installedTargets = new Set<string>();
  #link(file: string, relative: string, ancestors: Set<string>): void {
    this.entries.push([relative, 'binding', pathBinding(file)]);
    const target = normalizeAbsolutePath(realpathSync.native(file));
    if (target.split('/').includes('node_modules')) {
      this.installedTargets.add(target);
      this.entries.push([relative, 'installation-target', target]);
      return;
    }
    this.visit(target, `${relative}/@target`, ancestors);
  }
  #directory(file: string, relative: string, ancestors: Set<string>): void {
    const canonical = normalizeAbsolutePath(realpathSync.native(file));
    if (ancestors.has(canonical))
      throw new Error(`Cyclic local typeRoot: ${file}`);
    const next = new Set([...ancestors, canonical]);
    for (const entry of childNames(file))
      this.visit(path.join(file, entry), `${relative}/${entry}`, next);
  }
  #entry(input: {
    file: string;
    relative: string;
    stat: Stats;
    ancestors: Set<string>;
  }): void {
    const { file, relative, stat, ancestors } = input;
    this.entries.push(inventoryEntry(relative, stat));
    if (stat.isSymbolicLink()) this.#link(file, relative, ancestors);
    else if (stat.isDirectory()) this.#directory(file, relative, ancestors);
  }
  visit(file: string, relative: string, ancestors: Set<string>): void {
    const stat = optionalLstat(file);
    if (stat === undefined) this.entries.push([relative, 'missing']);
    else this.#entry({ file, relative, stat, ancestors });
  }
}
function inventory(root: string): {
  version: string;
  installedTargets: string[];
} {
  const scan = new LocalInventory();
  scan.visit(root, '', new Set());
  return {
    version: analysisHash([
      'local-typeRoots-metadata-v1',
      pathBinding(root),
      scan.entries,
    ]),
    installedTargets: [...scan.installedTargets].sort(compareCodeUnits),
  };
}
export function directoryObservation(root: string): {
  version: string;
  installedTargets: string[];
} {
  const first = inventory(root);
  if (inventory(root).version !== first.version)
    throw new AnalysisInputDriftError(root);
  return first;
}
export function directoryFingerprint(root: string): string {
  return directoryObservation(root).version;
}
