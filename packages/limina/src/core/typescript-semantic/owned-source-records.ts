import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import {
  collectTypeScriptSourceFileImports,
  ensureParentPointers,
} from '../import-analysis/typescript-imports';
import type { SourceSyntaxFactsCache } from './syntax-cache';
import type { OwnedSyntaxInput } from './syntax-input';

export function collectOwnedSourceRecords(options: {
  filePath: string;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
  syntaxFacts?: SourceSyntaxFactsCache;
  syntaxInput?: OwnedSyntaxInput;
}): ImportRecord[] {
  const { syntaxFacts, syntaxInput } = options;
  if (syntaxFacts === undefined)
    return collectTypeScriptSourceFileImports(options);
  if (syntaxInput === undefined) {
    syntaxFacts.bypass();
    return collectTypeScriptSourceFileImports(options);
  }
  return collectCachedRecords({ ...options, syntaxFacts, syntaxInput });
}

function collectCachedRecords(options: {
  filePath: string;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
  syntaxFacts: SourceSyntaxFactsCache;
  syntaxInput: OwnedSyntaxInput;
}): ImportRecord[] {
  const cached = options.syntaxFacts.get(options.syntaxInput);
  if (cached !== undefined) {
    // Cached records carry no AST links; the fresh AST still needs parents.
    ensureParentPointers(options.sourceFile, options.tsModule);
    return cached;
  }
  const records = collectTypeScriptSourceFileImports(options);
  options.syntaxFacts.set(options.syntaxInput, records);
  return records;
}
