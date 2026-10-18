import type {
  ResolvedCheckerModuleName,
  VueProjectSemanticIdentity,
} from '#checkers';
import type ts from 'typescript';
import { createFrameworkSemanticFailure } from '../framework-semantic/contracts';
import type { ImportRecord } from '../import-analysis/records';
import type { ModuleResolutionPair } from '../import-analysis/types';
import {
  getResolutionOrigin,
  resolveTypeWithOrigin,
} from '../typescript-semantic/resolution-origin';
import type { VueSemanticContext, VueSemanticContextManager } from './context';

function directive(context: VueSemanticContext, record: ImportRecord) {
  const source = context.getSemanticSourceFile(record.filePath);
  if (source === undefined) return null;
  const references = directiveReferences(source, record);
  const reference = references.find((item) =>
    [
      item.fileName === record.specifier,
      item.pos - 1 === record.locator.sourceStart,
      item.end + 1 === record.locator.sourceEnd,
    ].every(Boolean),
  );
  return reference === undefined ? null : { reference, source };
}

function pathTarget(
  context: VueSemanticContext,
  record: ImportRecord,
): ResolvedCheckerModuleName | null {
  const target = context.tsModule.resolveTripleslashReference(
    record.specifier,
    record.filePath,
  );
  return context.languageServiceHost.fileExists!(target)
    ? {
        resolvedFileName: target,
        resolvedBy: 'typescript',
        isExternalLibraryImport: false,
        resolutionOrigin: {
          version: 1,
          compiler: context.tsModule.version,
          route: 'local',
          target,
        },
      }
    : null;
}
function typeTarget(
  context: VueSemanticContext,
  record: ImportRecord,
  mode: ts.ResolutionMode,
): ResolvedCheckerModuleName | null {
  const target = resolveTypeWithOrigin(
    context.tsModule,
    record.specifier,
    record.filePath,
    context.identity.options,
    context.languageServiceHost as ts.ModuleResolutionHost,
    undefined,
    undefined,
    mode,
  ).resolvedTypeReferenceDirective;
  return target?.resolvedFileName === undefined
    ? null
    : {
        resolvedFileName: target.resolvedFileName,
        resolvedBy: 'typescript',
        isExternalLibraryImport: target.isExternalLibraryImport === true,
        resolutionOrigin: getResolutionOrigin(target),
      };
}

export function resolveVueReferenceDirective(options: {
  identity: VueProjectSemanticIdentity;
  importRecord: ImportRecord;
  manager: VueSemanticContextManager;
  oxc: string | null;
}): ModuleResolutionPair {
  const context = options.manager.acquire(options.identity);
  const observed = directive(context, options.importRecord);
  if (observed === null)
    return {
      oxc: options.oxc,
      typescript: null,
      semanticFailure: createFrameworkSemanticFailure({
        framework: 'vue',
        scopeIdentity: options.identity.id,
        stage: 'source-map-mismatch',
        reason:
          'Vue reference directive did not identify one actual compiler input directive.',
      }),
    };
  const mode =
    observed.reference.resolutionMode ?? observed.source.impliedNodeFormat;
  const target = resolvedTarget(context, options.importRecord, mode);
  return {
    oxc: options.oxc,
    typescript: target,
    semanticEvidence: {
      framework: 'vue',
      identityId: options.identity.id,
      provenance: 'direct-source',
      resolutionMode: String(mode),
      semanticSpecifier: options.importRecord.specifier,
      sourceRecord: options.importRecord,
      target,
    },
  };
}

function directiveReferences(source: ts.SourceFile, record: ImportRecord) {
  return record.kind === 'triple-slash-path'
    ? source.referencedFiles
    : source.typeReferenceDirectives;
}

function resolvedTarget(
  context: VueSemanticContext,
  record: ImportRecord,
  mode: ts.ResolutionMode,
) {
  return record.kind === 'triple-slash-path'
    ? pathTarget(context, record)
    : typeTarget(context, record, mode);
}
