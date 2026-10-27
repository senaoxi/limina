import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import {
  PhysicalFileReplay,
  resolvePhysicalPath,
} from '#utils/physical-file-identity';
import { AsyncLocalStorage } from 'node:async_hooks';
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

type LinkBindings = [string, string][];
interface BindingRound {
  ancestors: Map<string, LinkBindings>;
  leaves?: Map<string, unknown>;
}
const bindingRounds = new AsyncLocalStorage<BindingRound>();

/**
Ancestor link observations live for one input replay, never across effects.
*/
export class PathBindingReplay {
  readonly #round: BindingRound;
  readonly #physical: PhysicalFileReplay | undefined;

  constructor(options: { reuseLeafBindings?: boolean } = {}) {
    this.#round = {
      ancestors: new Map(),
      leaves: options.reuseLeafBindings ? new Map() : undefined,
    };
    this.#physical = options.reuseLeafBindings
      ? new PhysicalFileReplay()
      : undefined;
  }

  run<T>(operation: () => T): T {
    const run = () => bindingRounds.run(this.#round, operation);
    return this.#physical === undefined ? run() : this.#physical.run(run);
  }
}

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
  const cursor = normalizeAbsolutePath(file);
  const links: LinkBindings = [];
  recordLink(cursor, links);
  const parent = path.dirname(cursor);
  return parent === cursor ? links : [...links, ...parentBindings(parent)];
}
function parentBindings(file: string): LinkBindings {
  const bindings = bindingRounds.getStore()?.ancestors;
  if (bindings === undefined) return collectParentBindings(file);
  const previous = bindings.get(file);
  if (previous !== undefined) return previous;
  const links = collectParentBindings(file);
  bindings.set(file, links);
  return links;
}
function collectParentBindings(file: string): LinkBindings {
  const links: LinkBindings = [];
  recordLink(file, links);
  const parent = path.dirname(file);
  if (parent !== file) links.push(...parentBindings(parent));
  return links;
}
function physicalBinding(file: string): [string, string | null] {
  const stat = optionalLstat(file);
  return stat === undefined
    ? ['missing', null]
    : [entryKind(stat), realBinding(file, stat.isSymbolicLink())];
}
function realBinding(file: string, isLink: boolean): string | null {
  try {
    return resolvePhysicalPath(file, isLink);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return null;
    throw error;
  }
}
export function pathBinding(file: string): unknown {
  const leaves = bindingRounds.getStore()?.leaves;
  const previous = leaves?.get(file);
  if (previous !== undefined) return previous;
  const physical = physicalBinding(file);
  const links = linkBindings(file);
  const value = [file, ...physical, links];
  if (leaves !== undefined) {
    for (const link of links) Object.freeze(link);
    Object.freeze(links);
    leaves.set(file, Object.freeze(value));
  }
  return value;
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
