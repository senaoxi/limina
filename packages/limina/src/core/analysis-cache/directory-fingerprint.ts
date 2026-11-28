import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { entryKind, optionalLstat, pathBinding } from '#utils/path-binding';
import { readdirSync, realpathSync, type Stats } from 'node:fs';
import path from 'pathe';
import { AnalysisInputDriftError } from './contracts';
import { analysisHash } from './identity';
import { physicalEntry } from './physical-entry';

export { pathBinding, PathBindingReplay } from '#utils/path-binding';

function childNames(file: string): string[] {
  return readdirSync(file)
    .filter((entry) => entry !== 'node_modules')
    .sort(compareCodeUnits);
}
function inventoryEntry(relative: string, stat: Stats): unknown {
  return [relative, entryKind(stat), stat.isFile() ? stat.mtimeMs : null];
}
export function packageManifestState(file: string): unknown {
  return [pathBinding(file), physicalEntry(file)];
}
class LocalInventory {
  readonly entries: unknown[] = [];
  #link(file: string, relative: string, ancestors: Set<string>): void {
    this.entries.push([relative, 'binding', pathBinding(file)]);
    const target = normalizeAbsolutePath(realpathSync.native(file));
    if (target.split('/').includes('node_modules')) {
      this.entries.push([
        relative,
        'installed-package',
        target,
        packageManifestState(path.join(target, 'package.json')),
      ]);
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
} {
  const scan = new LocalInventory();
  scan.visit(root, '', new Set());
  return {
    version: analysisHash([
      'local-typeRoots-metadata-v1',
      pathBinding(root),
      scan.entries,
    ]),
  };
}
export function directoryObservation(root: string): {
  version: string;
} {
  const first = inventory(root);
  if (inventory(root).version !== first.version)
    throw new AnalysisInputDriftError(root);
  return first;
}
export function directoryFingerprint(root: string): string {
  return directoryObservation(root).version;
}
