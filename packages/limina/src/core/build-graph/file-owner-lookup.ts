import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { nativeCompilerPathPolicy } from '../typescript-semantic/compiler-path-key';

type Owners = Map<string, Set<string>>;

export interface FileOwnerInput {
  configPath: string;
  fileNames: readonly string[];
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
Analysis-local compiler membership; physical aliases never add owners.
*/
export class FileOwnerLookup {
  readonly #compiler = new Map<string, Owners>();
  readonly #fileKey: (file: string) => string;

  constructor(
    inputs: Iterable<FileOwnerInput>,
    fileKey: (file: string) => string = nativeCompilerPathPolicy().key,
  ) {
    this.#fileKey = fileKey;
    for (const input of inputs) this.#addInput(input);
  }

  #lookup(fileName: string): Owners | undefined {
    return this.#compiler.get(this.#fileKey(fileName));
  }

  #addInput(input: FileOwnerInput): void {
    for (const fileName of input.fileNames) {
      const normalized = normalizeAbsolutePath(fileName);
      const entry = { configPath: input.configPath, fileName: normalized };
      addOwner({
        ...entry,
        identity: this.#fileKey(normalized),
        index: this.#compiler,
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
}
