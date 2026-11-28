import { normalizeAbsolutePath } from '#utils/path';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticResolution,
} from './contracts';
import type { DeclarationEntry } from './declaration-closure';
import type { NativeDependencyFact } from './dependency-fact';
import type {
  FileDependencyFacts,
  FileDependencyFactsReader,
} from './file-dependency-facts';
import {
  createImportRecordIdentity,
  nativeOccurrenceSpanKeys,
} from './import-record';
import {
  captureNativeContextInventory,
  type NativeContextInventory,
} from './native-context-inventory';
import {
  nativeFileRequest,
  type NativeFileRequest,
} from './native-file-requests';
import {
  NativeObservationAdapter,
  type NativeProgramObservationOptions,
} from './native-observation-adapter';
import { nativeProgramFacts } from './native-program-facts';
import {
  nativeProgramRecords,
  type NativeRequestRecord,
} from './native-program-records';

export interface NativeContextData {
  evidence: NativeEvidenceSnapshot;
  inventory: NativeContextInventory;
  records: readonly NativeRequestRecord[];
  facts: Map<string, NativeDependencyFact>;
  syntax: ReadonlyMap<string, FileDependencyFacts>;
}

/**
 * Compiler lifetime ends after collection. The consumer receives only owned
 * records and frozen evidence; this context cannot initialize a TypeChecker.
 */
export class NativeDependencyContext
  implements TypeScriptSemanticDependencyContext
{
  readonly #records = new Map<string, ImportRecord[]>();
  readonly #facts: Map<string, NativeDependencyFact>;
  readonly #factsBySpan = new Map<string, NativeDependencyFact>();
  readonly #files: Set<string>;
  readonly #typeEntries: DeclarationEntry[];
  readonly #syntax: ReadonlyMap<string, FileDependencyFacts>;
  readonly identity: string;
  readonly nativeEvidence: NativeEvidenceSnapshot;
  readonly nativeInventory: NativeContextInventory;

  constructor(
    options: NativeProgramObservationOptions,
    adapter: NativeObservationAdapter = new NativeObservationAdapter(options),
    readSyntax?: FileDependencyFactsReader,
    data: NativeContextData = captureContextData(adapter, readSyntax),
  ) {
    this.identity = options.context.id;
    this.nativeEvidence = data.evidence;
    this.#files = new Set(data.inventory.members);
    this.#typeEntries = typeEnvironmentEntries(data.evidence);
    this.#syntax = data.syntax;
    this.nativeInventory = data.inventory;
    this.#facts = data.facts;
    this.#registerRecords(data.records);
  }

  #registerRecords(entries: readonly NativeRequestRecord[]): void {
    for (const entry of entries) {
      const { record } = entry;
      const records = this.#records.get(record.filePath) ?? [];
      records.push(record);
      this.#records.set(record.filePath, records);
      const fact = this.#facts.get(createImportRecordIdentity(record));
      if (fact !== undefined) {
        for (const spanKey of nativeOccurrenceSpanKeys(record)) {
          if (!this.#factsBySpan.has(spanKey)) {
            this.#factsBySpan.set(spanKey, fact);
          }
        }
      }
    }
  }

  #fact(record: ImportRecord): NativeDependencyFact {
    const fact = this.#facts.get(createImportRecordIdentity(record));
    if (fact === undefined)
      throw new Error('Occurrence was not observed in this Native context.');
    return fact;
  }

  getNativeFileRequests(file: string): readonly NativeFileRequest[] {
    return (this.#records.get(normalizeAbsolutePath(file)) ?? []).map(
      (record) => nativeFileRequest(record, this.#fact(record)),
    );
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
    return structuredClone(this.#fact(record));
  }

  findDependencyFact(record: ImportRecord): NativeDependencyFact | undefined {
    const exact = this.#facts.get(createImportRecordIdentity(record));
    if (exact !== undefined) return structuredClone(exact);
    for (const spanKey of nativeOccurrenceSpanKeys(record)) {
      const matched = this.#factsBySpan.get(spanKey);
      if (matched !== undefined) return structuredClone(matched);
    }
    return undefined;
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

function captureContextData(
  adapter: NativeObservationAdapter,
  readSyntax: FileDependencyFactsReader | undefined,
): NativeContextData {
  const records = nativeProgramRecords(adapter);
  const syntax =
    readSyntax === undefined ? new Map() : sourceSyntax(adapter, readSyntax);
  return {
    evidence: adapter.snapshot,
    inventory: captureNativeContextInventory(adapter, records, syntax),
    records,
    facts: nativeProgramFacts(adapter, records),
    syntax,
  };
}

function sourceSyntax(
  adapter: NativeObservationAdapter,
  read: FileDependencyFactsReader,
): ReadonlyMap<string, FileDependencyFacts> {
  const files = adapter.options.syntaxFiles;
  const sources =
    files === undefined
      ? adapter.program.getSourceFiles()
      : [...files]
          .map((file) => adapter.program.getSourceFile(file))
          .filter((source) => source !== undefined);
  return new Map(
    sources.map((source) => {
      const file = normalizeAbsolutePath(source.fileName);
      return [file, read(file, source.text, source)];
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
