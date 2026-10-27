import { normalizeAbsolutePath } from '#utils/path';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { analysisHash } from '../analysis-cache/identity';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticResolution,
} from './contracts';
import type { DeclarationEntry } from './declaration-closure';
import type { NativeDependencyFact } from './dependency-fact';
import {
  extractFileDependencyFacts,
  type FileDependencyFacts,
} from './file-dependency-facts';
import { createImportRecordIdentity } from './import-record';
import {
  captureNativeContextInventory,
  type NativeContextInventory,
} from './native-context-inventory';
import {
  NativeObservationAdapter,
  type NativeProgramObservationOptions,
} from './native-observation-adapter';
import { nativeProgramFacts } from './native-program-facts';
import { nativeProgramRecords } from './native-program-records';

/**
 * Compiler lifetime ends after collection. The consumer receives only owned
 * records and frozen evidence; this context cannot initialize a TypeChecker.
 */
export class NativeDependencyContext
  implements TypeScriptSemanticDependencyContext
{
  readonly #records = new Map<string, ImportRecord[]>();
  readonly #facts: Map<string, NativeDependencyFact>;
  readonly #files: Set<string>;
  readonly #typeEntries: DeclarationEntry[];
  readonly #syntax: ReadonlyMap<string, FileDependencyFacts>;
  readonly identity: string;
  readonly nativeEvidence: NativeEvidenceSnapshot;
  readonly nativeInventory: NativeContextInventory;

  constructor(
    options: NativeProgramObservationOptions,
    adapter: NativeObservationAdapter = new NativeObservationAdapter(options),
    shouldCaptureSyntax = false,
  ) {
    this.identity = options.context.id;
    this.nativeEvidence = adapter.snapshot;
    this.#files = new Set(
      adapter.program
        .getSourceFiles()
        .map((source) => normalizeAbsolutePath(source.fileName)),
    );
    this.#typeEntries = typeEnvironmentEntries(adapter.snapshot);
    const entries = nativeProgramRecords(adapter);
    this.#syntax = shouldCaptureSyntax ? sourceSyntax(adapter) : new Map();
    this.nativeInventory = captureNativeContextInventory(
      adapter,
      entries,
      this.#syntax,
    );
    this.#facts = nativeProgramFacts(adapter, entries);
    this.#registerRecords(entries);
  }

  #registerRecords(entries: ReturnType<typeof nativeProgramRecords>): void {
    for (const entry of entries) {
      const { record } = entry;
      const records = this.#records.get(record.filePath) ?? [];
      records.push(record);
      this.#records.set(record.filePath, records);
    }
  }

  getImportRecords(file: string): readonly ImportRecord[] {
    return structuredClone(
      this.#records.get(normalizeAbsolutePath(file)) ?? [],
    );
  }

  getFileDependencyFacts(file: string): FileDependencyFacts | undefined {
    return structuredClone(this.#syntax.get(normalizeAbsolutePath(file)));
  }

  getDependencyFact(record: ImportRecord): NativeDependencyFact {
    const fact = this.#facts.get(createImportRecordIdentity(record));
    if (fact === undefined)
      throw new Error('Occurrence was not observed in this Native context.');
    return structuredClone(fact);
  }

  resolveImportRecord(record: ImportRecord): TypeScriptSemanticResolution {
    return this.getDependencyFact(record).resolution;
  }

  getContributionFileNames(): readonly string[] {
    return [...this.#files];
  }

  hasSourceFile(file: string): boolean {
    return this.#files.has(normalizeAbsolutePath(file));
  }

  getTypeEnvironmentEntries(): readonly DeclarationEntry[] {
    return structuredClone(this.#typeEntries);
  }

  dispose(): void {
    // No compiler, host or checker survives the constructor.
  }
}

function sourceSyntax(
  adapter: NativeObservationAdapter,
): ReadonlyMap<string, FileDependencyFacts> {
  return new Map(
    adapter.program.getSourceFiles().map((source) => {
      const file = normalizeAbsolutePath(source.fileName);
      return [
        file,
        extractFileDependencyFacts(
          file,
          source.text,
          analysisHash(source.text),
        ),
      ];
    }),
  );
}

function typeEnvironmentEntries(
  snapshot: NativeEvidenceSnapshot,
): DeclarationEntry[] {
  const entries: DeclarationEntry[] = [];
  const requests = new Map(
    snapshot.requests.map((request) => [request.id, request]),
  );
  for (const resolution of snapshot.resolutions) {
    const request = requests.get(resolution.requestId)!;
    if (!isEnvironmentEntry(request, resolution)) continue;
    entries.push({
      kind: 'type-environment',
      name: request.specifier,
      fileName: resolution.target!.lexicalPath,
    });
  }
  return entries;
}

function isEnvironmentEntry(
  request: NativeEvidenceSnapshot['requests'][number],
  resolution: NativeEvidenceSnapshot['resolutions'][number],
): boolean {
  return request.sourceFile === null && resolution.target !== null;
}
