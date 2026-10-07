import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import { isNativeAmbientEvidence } from './ambient-provider';
import type { ContextServices } from './context-services';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticProject,
} from './contracts';
import {
  collectNativeDependencyFact,
  type NativeDependencyFact,
} from './dependency-fact';
export function beginNativeAnalysis(
  cache: NativeAnalysisCache | undefined,
  project: TypeScriptSemanticProject,
  services: ContextServices,
): void {
  if (cache === undefined) return;
  cache.qualifyFacts(
    project,
    isNativeAmbientEvidence(services.getAmbientEvidence),
  );
  cache.beginContext(project);
}
export function recordNativeProgram(
  cache: NativeAnalysisCache | undefined,
): void {
  cache?.recordProgram();
}
export function prepareNativeAnalysis(options: {
  cache: NativeAnalysisCache | undefined;
  project: TypeScriptSemanticProject;
  program: ts.Program;
  tsModule: typeof ts;
  capture(): void;
}): (() => void) | undefined {
  if (options.cache === undefined) return undefined;
  const release = options.cache.prepare(
    options.project,
    options.program,
    options.tsModule,
  );
  options.cache.registerContextCapture(
    options.project,
    options.program,
    options.capture,
  );
  return release;
}

export function collectContextFact(options: {
  cache: NativeAnalysisCache | undefined;
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  project: TypeScriptSemanticProject;
  getAmbientEvidence: typeof createAmbientTypeEvidence;
  tsModule: typeof ts;
}): NativeDependencyFact {
  const collect = () =>
    collectNativeDependencyFact({
      getAmbientEvidence: options.getAmbientEvidence,
      context: options.context,
      record: options.record,
      tsModule: options.tsModule,
    });
  if (options.cache === undefined) return collect();
  return options.cache.fact({
    project: options.project,
    record: options.record,
    occurrences: options.context.getImportRecords(options.record.filePath),
    resolution: options.context.resolveImportRecord(options.record),
    collect,
  });
}
