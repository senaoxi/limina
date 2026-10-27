import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type {
  CompilationObligationProof,
  CompilerMembership,
  ProjectReferenceRedirect,
} from '../dependency-semantics';
import { rangeIdentity } from '../framework-semantic/generated-dependencies';
import {
  canonicalTypeEvidenceIdentity,
  observeFrameworkTypeEvidence,
} from '../framework-semantic/prepared-type-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import { observeCompilerMembership } from '../typescript-semantic/compiler-membership';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import { vueCompilationObligation } from './compilation-obligation';
import type { VueSemanticContext } from './context';
import {
  collectSemanticDependencyEvidence,
  getVueMappedRangeIdentities,
} from './dependency';
import { vueDirectiveObligation } from './directive-obligation';

export interface VueTypeDependencyObservation {
  typeEvidence: TypeEvidence;
  compilerMembership: CompilerMembership;
}

interface ObservationOptions {
  context: VueSemanticContext;
  importRecord: ImportRecord;
  target: ResolvedCheckerModuleName | null;
}
function unsupported(reason: string): VueTypeDependencyObservation {
  return {
    typeEvidence: { kind: 'unsupported-checker', checker: 'vue-tsc', reason },
    compilerMembership: 'unobserved',
  };
}
function compilerMembership(options: ObservationOptions): CompilerMembership {
  return options.target === null
    ? 'unobserved'
    : observeCompilerMembership(
        options.context.program,
        options.target.resolvedFileName,
      );
}
function compilerInputEvidence(options: ObservationOptions): TypeEvidence {
  if (options.target === null) return { kind: 'missing' };
  const file = options.context.program.getSourceFile(
    options.target.resolvedFileName,
  );
  return file === undefined ? { kind: 'missing' } : sourceInputEvidence(file);
}
function sourceInputEvidence(file: ts.SourceFile): TypeEvidence {
  return {
    kind: file.isDeclarationFile ? 'concrete-declaration' : 'checker-source',
    filePath: file.fileName,
  };
}
function observeMappedDependency(
  options: ObservationOptions,
): VueTypeDependencyObservation {
  const dependency = collectSemanticDependencyEvidence(options);
  if (dependency.kind === 'unsupported') return unsupported(dependency.reason);
  const program = options.context.program;
  const evidence = dependency.candidates.map((candidate) =>
    observeFrameworkTypeEvidence({
      candidate,
      checkerName: 'vue-tsc',
      program,
      tsModule: options.context.tsModule,
    }),
  );
  return new Set(evidence.map(canonicalTypeEvidenceIdentity)).size === 1
    ? {
        typeEvidence: evidence[0]!,
        compilerMembership: compilerMembership(options),
      }
    : unsupported(
        'Vue mapped candidates did not agree on one actual type provider.',
      );
}
export function observeVueDependency(
  options: ObservationOptions,
): VueTypeDependencyObservation {
  return ['triple-slash-path', 'triple-slash-types'].includes(
    options.importRecord.kind,
  )
    ? {
        typeEvidence: compilerInputEvidence(options),
        compilerMembership: compilerMembership(options),
      }
    : observeMappedDependency(options);
}

export interface VueDependencyObservation {
  compilationObligation?: CompilationObligationProof;
  coverage: 'complete' | 'unsupported';
  reason?: string;
  redirect?: ProjectReferenceRedirect;
}
export function observeVueGraphDependency(
  options: ObservationOptions,
): VueDependencyObservation {
  return {
    coverage: 'complete',
    compilationObligation: graphObligation(options),
    redirect:
      options.target === null
        ? undefined
        : observeProjectReferenceRedirect(
            options.context.program,
            options.target.resolvedFileName,
            options.context.tsModule,
          ),
  };
}

function graphObligation(
  options: ObservationOptions,
): CompilationObligationProof {
  const { context, importRecord } = options;
  if (['triple-slash-path', 'triple-slash-types'].includes(importRecord.kind))
    return vueDirectiveObligation(context, importRecord);
  const source = context.program.getSourceFile(importRecord.filePath);
  const isMapped = context.identity.profilesByFileName.has(
    importRecord.filePath,
  );
  const ranges = isMapped
    ? getVueMappedRangeIdentities(options)
    : new Set([
        rangeIdentity(
          importRecord.locator.sourceStart,
          importRecord.locator.sourceEnd,
        ),
      ]);
  if (source === undefined || ranges === null)
    return {
      state: 'unknown',
      contextConfig: context.identity.configPath,
      reason: 'compiler-request-source-or-mapping-unavailable',
      requests: [],
    };
  const requests = context.compilerRequests
    .collect(context.program, source)
    .filter((request) => {
      const { sourceStart, sourceEnd } = request.record.locator;
      return (
        request.literal.text === importRecord.specifier &&
        [
          rangeIdentity(sourceStart, sourceEnd),
          rangeIdentity(sourceStart + 1, sourceEnd - 1),
        ].some((range) => ranges.has(range))
      );
    });
  const proof = vueCompilationObligation(context, requests);
  const target = options.target?.resolvedFileName;
  if (
    target !== undefined &&
    requests.some(
      (request) => request.raw?.resolvedModule?.resolvedFileName !== target,
    )
  )
    return {
      ...proof,
      state: 'unknown',
      reason: 'compiler-request-resolution-target-mismatch',
    };
  return proof;
}
