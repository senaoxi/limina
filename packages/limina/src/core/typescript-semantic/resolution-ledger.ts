import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticResolution } from './contracts';
import { createImportRecordIdentity } from './import-record';

function createConflictMessage(options: {
  existing: TypeScriptSemanticResolution;
  importRecord: ImportRecord;
  next: TypeScriptSemanticResolution;
}): string {
  return [
    'TypeScript semantic resolution changed for one import occurrence:',
    `  file: ${options.importRecord.filePath}`,
    `  kind: ${options.importRecord.kind}`,
    `  specifier: ${options.importRecord.specifier}`,
    `  locator: ${JSON.stringify(options.importRecord.locator)}`,
    `  first identity: ${options.existing.identity}`,
    `  next identity: ${options.next.identity}`,
  ].join('\n');
}

export class TypeScriptResolutionLedger {
  readonly #byImportRecord = new Map<string, TypeScriptSemanticResolution>();

  get(importRecord: ImportRecord): TypeScriptSemanticResolution | undefined {
    return this.#byImportRecord.get(createImportRecordIdentity(importRecord));
  }

  set(
    importRecord: ImportRecord,
    resolution: TypeScriptSemanticResolution,
  ): void {
    const key = createImportRecordIdentity(importRecord);
    const existing = this.#byImportRecord.get(key);
    if (this.#isSameResolution(existing, resolution)) return;
    this.#assertEmpty({ existing, importRecord, resolution });
    this.#byImportRecord.set(key, resolution);
  }

  #isSameResolution(
    existing: TypeScriptSemanticResolution | undefined,
    resolution: TypeScriptSemanticResolution,
  ): boolean {
    if (existing === undefined) return false;
    return existing.identity === resolution.identity;
  }

  #assertEmpty(options: {
    existing: TypeScriptSemanticResolution | undefined;
    importRecord: ImportRecord;
    resolution: TypeScriptSemanticResolution;
  }): void {
    if (options.existing === undefined) return;
    throw new Error(
      createConflictMessage({
        existing: options.existing,
        importRecord: options.importRecord,
        next: options.resolution,
      }),
    );
  }
}
