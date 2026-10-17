import type {
  ResolvedCheckerModuleName,
  VueProjectSemanticIdentity,
} from '#checkers';
import type ts from 'typescript';
import { occurrenceKey } from '../analysis-cache/semantic-state';
import type { VueQueryResults } from '../analysis-cache/vue-contracts';
import type { ImportAnalysisContext } from '../import-analysis/types';
import { collectTypeScriptSourceFileImports } from '../import-analysis/typescript-imports';
import type { VueSemanticContextManager } from './context';
import {
  observeVueGraphDependency,
  type VueDependencyObservation,
} from './dependency-observation';

type ObserveRequest = Parameters<
  NonNullable<ImportAnalysisContext['observeCheckerDependency']>
>[0];
function collectSupportFiles(
  manager: VueSemanticContextManager,
  identity: VueProjectSemanticIdentity,
): VueQueryResults['support-inputs'] {
  return (
    manager.query({
      identity,
      kind: 'support-inputs',
      request: [],
      collect: () => {
        const program = manager.acquire(identity).program;
        return program
          .getSourceFiles()
          .map((file) => supportInput(file, identity.toolchain.tsModule));
      },
    }) ?? []
  );
}
function observeDependency(
  manager: VueSemanticContextManager,
  identity: VueProjectSemanticIdentity,
  request: ObserveRequest,
): VueDependencyObservation {
  const evidence = request.resolution;
  const target =
    evidence.semanticEvidence === undefined
      ? evidence.typeScriptResolution
      : evidence.semanticEvidence.target;
  let observed: VueDependencyObservation | undefined;
  const restored = manager.query({
    identity,
    kind: 'dependency-observation',
    request: [
      request.importRecord.filePath,
      occurrenceKey(request.importRecord),
      targetIdentity(target),
    ],
    collect: () => {
      observed = observeVueGraphDependency({
        context: manager.acquire(identity),
        importRecord: request.importRecord,
        target,
      });
      return observed.coverage === 'complete' ? observed : undefined;
    },
  });
  return restored ?? observed!;
}
function targetIdentity(target: ResolvedCheckerModuleName | null) {
  return target === null
    ? null
    : [
        target.resolvedFileName,
        target.resolvedBy,
        target.isExternalLibraryImport,
      ];
}
function unsupported(checker: string | undefined): VueDependencyObservation {
  return {
    coverage: 'unsupported',
    reason: `The ${checker ?? 'unknown'} semantic authority has no dependency observation adapter.`,
  };
}
export function createVueDependencyObserver(
  manager: VueSemanticContextManager,
): Pick<
  ImportAnalysisContext,
  'collectCheckerSupportInputs' | 'observeCheckerDependency'
> {
  return {
    collectCheckerSupportInputs: (context) => {
      const identity = context.vueSemanticIdentity;
      return identity === undefined || context.semanticFamily !== 'vue'
        ? []
        : collectSupportFiles(manager, identity);
    },
    observeCheckerDependency: (request) => {
      const identity = request.context.vueSemanticIdentity;
      return identity === undefined || request.context.semanticFamily !== 'vue'
        ? unsupported(request.context.semanticFamily)
        : observeDependency(manager, identity, request);
    },
  };
}

function supportInput(
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): VueQueryResults['support-inputs'][number] {
  const records = collectTypeScriptSourceFileImports({
    filePath: sourceFile.fileName,
    sourceFile,
    tsModule,
  });
  // JSDoc text in declarations is documentation, not a compiler dependency.
  // JS support inputs retain their JSDoc queries and must obtain real evidence.
  return {
    filePath: sourceFile.fileName,
    records: records.filter(
      (record) =>
        !(sourceFile.isDeclarationFile && record.kind === 'jsdoc-import'),
    ),
  };
}
