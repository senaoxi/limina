import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticResolution,
} from './contracts';

interface EvidenceOptions {
  getAmbientEvidence: typeof createAmbientTypeEvidence;
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  resolution: TypeScriptSemanticResolution;
  tsModule: typeof ts;
}

function sourceFileEvidence(file: ts.SourceFile | undefined): TypeEvidence {
  if (file === undefined) return { kind: 'missing' };
  return {
    filePath: normalizeAbsolutePath(file.fileName),
    kind: file.isDeclarationFile ? 'concrete-declaration' : 'checker-source',
  };
}

function isCompilerInputChannel(
  channel: TypeScriptSemanticResolution['channel'],
): boolean {
  return [
    'triple-slash-path',
    'triple-slash-types',
    'lib-environment',
  ].includes(channel);
}

function getResolvedProgramFile(options: EvidenceOptions) {
  const target = options.resolution.target;
  return target === null
    ? undefined
    : options.context.getSourceFile(target.resolvedFileName);
}

function getModuleProvider(options: {
  base: EvidenceOptions;
  symbol: ts.Symbol;
}): ts.SourceFile | undefined {
  const file = getResolvedProgramFile(options.base);
  if (file === undefined) return undefined;
  // A redirected declaration is the provider, not the original resolved .ts.
  // Other declarations on a merged symbol may be augmentations of this file.
  return symbolProvidesFile(options.symbol, file) ? file : undefined;
}

function symbolProvidesFile(symbol: ts.Symbol, file: ts.SourceFile): boolean {
  return symbol.declarations?.includes(file) === true;
}

function collectModuleProviderEvidence(options: EvidenceOptions): TypeEvidence {
  const symbol = options.context.getSymbolAtImportRecord(options.record);
  if (symbol === undefined) return { kind: 'missing' };
  const ambient = options.getAmbientEvidence(symbol, options.tsModule);
  return ambient.kind === 'ambient'
    ? ambient
    : sourceFileEvidence(getModuleProvider({ base: options, symbol }));
}

export function collectNativeProviderEvidence(
  options: EvidenceOptions,
): TypeEvidence {
  return isCompilerInputChannel(options.resolution.channel)
    ? sourceFileEvidence(getResolvedProgramFile(options))
    : collectModuleProviderEvidence(options);
}

export function isOriginalTargetInProgram(options: {
  context: TypeScriptSemanticContext;
  target: string;
  tsModule: typeof ts;
}): boolean {
  const file = options.context.getSourceFile(options.target);
  if (file === undefined) return false;
  const names = [file.fileName, options.target].map(normalizeAbsolutePath);
  const identities = options.tsModule.sys.useCaseSensitiveFileNames
    ? names
    : names.map((name) => name.toLowerCase());
  return identities[0] === identities[1];
}
