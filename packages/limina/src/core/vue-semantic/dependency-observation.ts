import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type {
  CompilerMembership,
  ProjectReferenceRedirect,
} from '../dependency-semantics';
import {
  canonicalTypeEvidenceIdentity,
  observeFrameworkTypeEvidence,
} from '../framework-semantic/prepared-type-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import { observeCompilerMembership } from '../typescript-semantic/compiler-membership';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import type { VueSemanticContext } from './context';
import { collectSemanticDependencyEvidence } from './dependency';

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
  coverage: 'complete' | 'unsupported';
  reason?: string;
  redirect?: ProjectReferenceRedirect;
}
export function observeVueGraphDependency(
  options: ObservationOptions,
): VueDependencyObservation {
  return {
    coverage: 'complete',
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
