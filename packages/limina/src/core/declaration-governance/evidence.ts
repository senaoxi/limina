import { createRequire } from 'node:module';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from '../project-dependencies/contracts';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';

const requireFromLimina = createRequire(import.meta.url);

export function nativeDeclarationEvidence(
  snapshot: NativeEvidenceSnapshot,
  checker = 'tsc',
): DeclarationCompilationEvidence | undefined {
  const context = snapshot.contexts[0];
  if (context?.authority.phase !== 'locked' || snapshot.contexts.length !== 1)
    return undefined;
  return freezeNativeData({
    version: 5,
    authority: {
      checker,
      adapter: 'typescript-declarations-v1',
      toolchain: context.inputs.toolchain,
      executionEntry: requireFromLimina.resolve('typescript/bin/tsc'),
    },
    sourceConfig: context.inputs.config,
    contextId: context.id,
    purpose: 'graph',
    coverageVersion: context.inputs.coverage,
    requestOrigins: snapshot.requests.map((request) => ({
      id: request.id,
      file: request.sourceFile?.lexicalPath ?? context.inputs.config,
      specifier: request.specifier,
    })),
    declarations: snapshot.relations.flatMap((relation) =>
      relation.kind === 'declaration-consumption' &&
      relation.consumerContextId === context.id
        ? [
            {
              kind: 'consumption' as const,
              contextId: context.id,
              consumerConfig: context.inputs.config,
              file: relation.file,
              requestIds: relation.requestIds,
            },
          ]
        : [],
    ),
    completeness: snapshot.run === 'completed' ? 'complete' : 'incomplete',
  });
}

export function collectDeclarationCompilationEvidence(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
): DeclarationCompilationEvidence | undefined {
  if (
    collection.nativeEvidence !== undefined &&
    request.context.semanticAuthority.family === 'typescript'
  )
    return nativeDeclarationEvidence(
      collection.nativeEvidence,
      request.context.analysisChecker,
    );
  const index =
    request.caches?.sourceConfigCoverage ??
    request.context.workspaceSourceBoundary.sourceConfigCoverage;
  const identity = request.context.vueSemanticIdentity;
  if (identity === undefined || index === undefined) return undefined;
  const inventory = request.importAnalysis.collectCheckerRequestInventory?.({
    checkerPresets: [],
    extensions: [...request.context.extensions],
    semanticFamily: 'vue',
    vueSemanticIdentity: identity,
  });
  if (inventory === undefined) return undefined;
  const fromVue = createRequire(identity.toolchain.paths.vueTsc);
  return freezeNativeData({
    version: 5,
    authority: {
      checker: request.context.analysisChecker ?? 'vue-tsc',
      adapter: 'vue-declarations-v1',
      toolchain: nativeFingerprint([
        identity.toolchain.paths,
        identity.toolchain.versions,
      ]),
      executionEntry: fromVue.resolve('vue-tsc/bin/vue-tsc.js'),
    },
    sourceConfig: request.context.configPath,
    contextId: identity.id,
    purpose: 'graph',
    coverageVersion: nativeFingerprint(index),
    requestOrigins: inventory.requests.map((item) => ({
      id: nativeFingerprint([identity.id, item]),
      file: item.file,
      specifier: item.specifier,
    })),
    completeness:
      collection.failures.length === 0 && inventory.complete
        ? 'complete'
        : 'incomplete',
    declarations: inventory.requests.flatMap((item) => {
      if (
        item.target === null ||
        !isDeclarationFile(item.target) ||
        item.channel === 'augmentation'
      )
        return [];
      if (
        item.environment.noResolve === true &&
        ['module', 'implicit', 'path-directive'].includes(item.channel)
      )
        return [];
      return [
        {
          kind:
            item.channel === 'root'
              ? ('root-input' as const)
              : ('consumption' as const),
          contextId: identity.id,
          consumerConfig: request.context.configPath,
          file: observeNativeFileIdentity(item.target, index.inputVersion),
          requestIds: [nativeFingerprint([identity.id, item])],
        },
      ];
    }),
  });
}
