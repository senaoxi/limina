import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticContext } from './contracts';
import type { FileDependencyFactsReader } from './file-dependency-facts';
import { createImportRecordIdentity } from './import-record';
import { TypeCheckerObservation } from './metrics';
import { NativeDependencyContext } from './native-dependency-context';
import {
  NativeObservationAdapter,
  type NativeProgramObservationOptions,
} from './native-observation-adapter';
import { nativeProgramRecords } from './native-program-records';

/**
Explicit symbol queries use the same physical frontier. No diagnostic from this
incomplete Program becomes a final Checker diagnostic.
*/
export class NativeSemanticContext
  extends NativeDependencyContext
  implements TypeScriptSemanticContext
{
  #program: ts.Program | undefined;
  readonly #locations = new Map<string, ts.StringLiteralLike>();
  readonly #checker: TypeCheckerObservation;

  constructor(
    options: NativeProgramObservationOptions,
    readSyntax?: FileDependencyFactsReader,
  ) {
    const adapter = new NativeObservationAdapter(options);
    super(options, adapter, readSyntax);
    this.#program = adapter.program;
    this.#checker = new TypeCheckerObservation(options.metrics);
    const literals = new Map(
      adapter.modules.map((module) => [module.requestId, module.literal]),
    );
    for (const entry of nativeProgramRecords(adapter)) {
      const literal = literals.get(entry.request.id);
      if (literal !== undefined)
        this.#locations.set(createImportRecordIdentity(entry.record), literal);
    }
  }

  get program(): ts.Program {
    if (this.#program === undefined)
      throw new Error('Native semantic context was disposed.');
    return this.#program;
  }

  getSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.program.getSourceFile(normalizeAbsolutePath(fileName));
  }

  getSymbolAtImportRecord(record: ImportRecord): ts.Symbol | undefined {
    const literal = this.#locations.get(createImportRecordIdentity(record));
    return literal === undefined
      ? undefined
      : this.#checker.get(this.program).getSymbolAtLocation(literal);
  }

  override dispose(): void {
    this.#locations.clear();
    this.#program = undefined;
  }
}
