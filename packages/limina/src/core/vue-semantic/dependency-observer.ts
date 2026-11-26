import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import type { VueQueryResults } from '../analysis-cache/vue-contracts';
import { vueObservationRequest } from '../analysis-cache/vue-graph-facts';
import type { ImportAnalysisContext } from '../import-analysis/types';
import {
  collectFrameworkEnvironmentEntries,
  collectTypeEnvironmentEntries,
} from '../typescript-semantic/type-environment-entries';
import { collectVueCompilerSource } from './compiler-source';
import type { VueSemanticContextManager } from './context';
import {
  observeVueGraphDependency,
  type VueDependencyObservation,
} from './dependency-observation';
import { collectVueRequestInventory } from './request-inventory';

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
        const context = manager.acquire(identity);
        const program = context.program;
        return program.getSourceFiles().map((file) => ({
          filePath: file.fileName,
          records: collectVueCompilerSource(context, file.fileName)!,
        }));
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
    request: vueObservationRequest(request.importRecord, target),
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
  | 'restoreVueGraphFacts'
  | 'collectCheckerRequestInventory'
  | 'collectCheckerSourceRecords'
  | 'collectCheckerSupportInputs'
  | 'observeCheckerDependency'
  | 'collectCheckerTypeEnvironmentEntries'
> {
  return {
    restoreVueGraphFacts: (identity) => manager.graphFacts(identity),
    collectCheckerRequestInventory: (request) => {
      const identity = request.vueSemanticIdentity;
      return identity === undefined || request.semanticFamily !== 'vue'
        ? undefined
        : manager.query({
            identity,
            kind: 'request-inventory',
            request: [],
            collect: () =>
              collectVueRequestInventory(manager.acquire(identity)),
          });
    },
    collectCheckerSourceRecords: ({ context, filePath }) => {
      const identity = context.vueSemanticIdentity;
      return identity === undefined || context.semanticFamily !== 'vue'
        ? undefined
        : manager.query({
            identity,
            kind: 'compiler-source',
            request: [filePath],
            collect: () =>
              collectVueCompilerSource(manager.acquire(identity), filePath),
          });
    },
    collectCheckerTypeEnvironmentEntries: (request) => {
      const identity = request.vueSemanticIdentity;
      if ([!identity, request.semanticFamily !== 'vue'].some(Boolean))
        return [];
      return (
        manager.query({
          identity: identity!,
          kind: 'type-environment-entries',
          request: [],
          collect: () => {
            const context = manager.acquire(identity!);
            return [
              ...collectFrameworkEnvironmentEntries({
                compiler: context.tsModule,
                host: context.languageServiceHost as ts.ModuleResolutionHost,
                rootNames: identity!.fileNames,
                scriptNames: context.languageServiceHost.getScriptFileNames(),
              }),
              ...collectTypeEnvironmentEntries({
                compiler: context.tsModule,
                options: identity!.options,
                host: context.languageServiceHost as ts.ModuleResolutionHost,
                configPath: identity!.configPath,
              }),
            ];
          },
        }) ?? []
      );
    },
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
