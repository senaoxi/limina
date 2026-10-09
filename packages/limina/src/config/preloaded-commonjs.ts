import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';

function isModule(entry: NodeJS.Module | undefined): entry is NodeJS.Module {
  return entry?.filename !== undefined;
}
function isEntryParent(module: NodeJS.Module, entry: string): boolean {
  const parent = module.parent?.filename;
  return parent !== undefined && normalizeAbsolutePath(parent) === entry;
}
function rejectPreloadedModule(path: string): never {
  throw new Error(
    `Limina configuration uses a preloaded CommonJS module whose executed source cannot be observed: ${path}. Run the CLI in a new process without preloading configuration dependencies.`,
  );
}
/**
Read-only admission check; it never evicts application modules or resolver caches.
*/
export class PreloadedCommonJs {
  readonly #modules = new Map(
    Object.values(createRequire(import.meta.url).cache)
      .filter(isModule)
      .map((entry) => [normalizeAbsolutePath(entry.filename!), entry]),
  );

  assertEntry(path: string): void {
    const entry = normalizeAbsolutePath(path);
    this.assertModule(entry);
    for (const [filename, module] of this.#modules)
      if (isEntryParent(module, entry)) rejectPreloadedModule(filename);
  }

  assertModule(path: string): void {
    if (this.#modules.has(path)) rejectPreloadedModule(path);
  }
}
