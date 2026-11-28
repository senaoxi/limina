import { normalizeAbsolutePath } from '#utils/path';
import {
  PhysicalFileReplay,
  resolvePhysicalPath,
} from '#utils/physical-file-identity';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readlinkSync, type Stats } from 'node:fs';
import path from 'pathe';

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

export function optionalLstat(file: string): Stats | undefined {
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
export function entryKind(stat: Stats): string {
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
