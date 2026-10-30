import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from '../typescript-semantic/compiler-coverage';

type Owners = Map<string, Set<string>>;

export interface FileOwnerInput {
  configPath: string;
  fileNames: readonly string[];
}

function realPath(fileName: string): string {
  try {
    return normalizeAbsolutePath(realpathSync.native(fileName));
  } catch (error) {
    if (isMissingPath(error)) return fileName;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function addOwner(options: {
  index: Map<string, Owners>;
  identity: string;
  configPath: string;
  fileName: string;
}): void {
  const owners = options.index.get(options.identity) ?? new Map();
  const files = owners.get(options.configPath) ?? new Set();
  files.add(options.fileName);
  owners.set(options.configPath, files);
  options.index.set(options.identity, owners);
}

/**
An analysis-local index. Implementations use compiler keys; declarations retain
physical identity fallback for declaration-context governance.
*/
export class FileOwnerLookup {
  readonly #compiler = new Map<string, Owners>();

  readonly #lexical = new Map<string, Owners>();

  readonly #canonical = new Map<string, Owners>();

  readonly #realPaths = new Map<string, string>();

  constructor(inputs: Iterable<FileOwnerInput>) {
    for (const input of inputs) this.#addInput(input);
  }

  #lookup(fileName: string): Owners | undefined {
    const normalized = normalizeAbsolutePath(fileName);
    return isDeclarationFile(normalized)
      ? (this.#lexical.get(normalized) ??
          this.#canonical.get(this.#canonicalPath(normalized)))
      : this.#compiler.get(compilerFileKey(normalized));
  }

  #canonicalPath(normalized: string): string {
    const cached = this.#realPaths.get(normalized);
    if (cached !== undefined) return cached;
    const canonical = realPath(normalized);
    this.#realPaths.set(normalized, canonical);
    return canonical;
  }

  #addInput(input: FileOwnerInput): void {
    for (const fileName of input.fileNames) {
      const normalized = normalizeAbsolutePath(fileName);
      const entry = { configPath: input.configPath, fileName: normalized };
      addOwner({ ...entry, identity: normalized, index: this.#lexical });
      addOwner({
        ...entry,
        identity: compilerFileKey(normalized),
        index: this.#compiler,
      });
      addOwner({
        ...entry,
        identity: this.#canonicalPath(normalized),
        index: this.#canonical,
      });
    }
  }

  get(fileName: string): string[] | undefined {
    const owners = this.#lookup(fileName);
    return owners === undefined
      ? undefined
      : owners.keys().toArray().sort(compareCodeUnits);
  }

  registeredFileNames(fileName: string, configPath: string): string[] {
    return [...(this.#lookup(fileName)?.get(configPath) ?? [])].sort(
      compareCodeUnits,
    );
  }

  isCanonicalAmbiguous(fileName: string): boolean {
    const normalized = normalizeAbsolutePath(fileName);
    if (!isDeclarationFile(normalized) || this.#lexical.has(normalized))
      return false;
    const owners = this.#lookup(normalized);
    return owners !== undefined && owners.size > 1;
  }
}
