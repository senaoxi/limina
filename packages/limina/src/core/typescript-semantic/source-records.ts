import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptInclusionLedger } from './admission';
import { findDirectiveRecord } from './import-record';
import { collectOwnedSourceRecords } from './owned-source-records';
import { resolveTripleSlashPathSemanticRecord } from './resolution';
import type { TypeScriptResolutionLedger } from './resolution-ledger';
import type { SourceSyntaxFactsCache } from './syntax-cache';
import type { OwnedSyntaxInput } from './syntax-input';

export function collectSemanticSourceRecords(options: {
  admission: TypeScriptInclusionLedger;
  contextIdentity: string;
  ledger: TypeScriptResolutionLedger;
  syntaxFacts?: SourceSyntaxFactsCache;
  syntaxInput?: OwnedSyntaxInput;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): readonly ImportRecord[] {
  const filePath = normalizeAbsolutePath(options.sourceFile.fileName);
  const records = collectOwnedSourceRecords({
    filePath,
    syntaxFacts: options.syntaxFacts,
    syntaxInput: options.syntaxInput,
    sourceFile: options.sourceFile,
    tsModule: options.tsModule,
  });

  admitExplicitReferences({ ...options, filePath, records });
  admitLibReferences(options);
  return records;
}

function admitExplicitReferences(options: {
  admission: TypeScriptInclusionLedger;
  contextIdentity: string;
  filePath: string;
  ledger: TypeScriptResolutionLedger;
  records: readonly ImportRecord[];
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): void {
  const occurrenceBySpecifier = new Map<string, number>();
  for (const reference of options.sourceFile.referencedFiles) {
    const occurrence = nextOccurrence(
      occurrenceBySpecifier,
      reference.fileName,
    );
    const record = findDirectiveRecord({
      kind: 'triple-slash-path',
      occurrence,
      records: options.records,
      specifier: reference.fileName,
    });
    const resolvedFileName = options.tsModule.resolveTripleslashReference(
      reference.fileName,
      options.filePath,
    );
    options.admission.addExplicitReference(resolvedFileName);
    storeExplicitReference({ ...options, record });
  }
}

function nextOccurrence(
  occurrences: Map<string, number>,
  specifier: string,
): number {
  const occurrence = occurrences.get(specifier) ?? 0;
  occurrences.set(specifier, occurrence + 1);
  return occurrence;
}

function storeExplicitReference(options: {
  contextIdentity: string;
  ledger: TypeScriptResolutionLedger;
  record: ImportRecord | undefined;
  tsModule: typeof ts;
}): void {
  if (options.record === undefined) return;
  options.ledger.set(
    options.record,
    resolveTripleSlashPathSemanticRecord({
      contextIdentity: options.contextIdentity,
      importRecord: options.record,
      tsModule: options.tsModule,
    }),
  );
}

function admitLibReferences(options: {
  admission: TypeScriptInclusionLedger;
  sourceFile: ts.SourceFile;
}): void {
  for (const reference of options.sourceFile.libReferenceDirectives) {
    options.admission.addLibReference(reference.fileName);
  }
}
