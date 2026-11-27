import { currentProfile } from '../../application/analysis/observability';
import type { ImportRecord } from '../import-analysis/records';
import type { NativeFileRequest } from '../typescript-semantic/native-file-requests';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { effectiveReferenceInputs } from './declaration-projection';
import { getProjectSemanticCacheIdentity } from './identity';
import { retainNativeObservation } from './native-evidence-retention';
import { projectNativeReferenceFacts } from './native-reference-facts';
import {
  collectProjectDependencies,
  registerNativeConfigContext,
} from './provider';
import {
  createCollectionContext,
  projectDependencyFactsKey,
  restoreCollectionContext,
} from './semantic-facts';

type NativeReferenceDependency = Pick<
  ProjectDependency,
  | 'importRecord'
  | 'resolvedFilePath'
  | 'targetKind'
  | 'referenceRequirement'
  | 'typeEvidence'
> & {
  readonly nativeFact: {
    readonly nativeEvidence: NativeFileRequest['evidence'];
  };
  readonly evidence?: never;
  readonly supplementalAssessment?: never;
};
export type ReferenceDependency = NativeReferenceDependency | ProjectDependency;

export interface ReferenceGraphFacts {
  declarationEvidence?: ProjectDependencyCollection['declarationEvidence'];
  nativeEvidence?: ProjectDependencyCollection['nativeEvidence'];
  dependencies: readonly ReferenceDependency[];
  referenceInputs: readonly ReferenceDependency[];
  ownershipInputs: readonly ReferenceDependency[];
  unresolvedNativeRecords: readonly {
    record: ImportRecord;
    evidence?: NativeFileRequest['evidence'];
  }[];
  failures: ProjectDependencyCollection['failures'];
  observations: readonly (
    | { kind: 'missing'; importRecord: ImportRecord }
    | { kind: 'resource' | 'semantic-only'; importRecord: ImportRecord }
    | { kind: 'unmapped-generated' }
  )[];
}

/** One run binds the compiler inventory first. Ownership, context selection and
 * provider selection consume these inputs independently and remain current. */
export function readReferenceGraphFacts(
  input: ProjectDependencyRequest,
): ReferenceGraphFacts {
  if (input.context.semanticAuthority.family !== 'typescript')
    return adapterReferenceFacts(input);
  const request = {
    ...input,
    projectSemanticCacheIdentity: getProjectSemanticCacheIdentity(input),
  };
  const key = projectDependencyFactsKey(request);
  const memo = request.caches?.referenceFacts;
  const retained =
    request.caches?.typeScriptSemanticFactsCache.get(key) ??
    restoreCollectionContext(request);
  const fresh =
    retained === undefined ? createCollectionContext(request) : undefined;
  const context = retained ?? fresh!;
  try {
    const previous = memo?.get(key);
    const observer = currentProfile();
    if (previous?.context === context) {
      observer?.metric(
        'graph.reference-facts.native.memo-hits',
        ['project', observer.project(input.context.configPath)],
        'calls',
        1,
      );
      return previous.facts;
    }
    // The dependency-only context owns detached compiler data after collection.
    request.caches?.typeScriptSemanticFactsCache.set(key, context);
    registerNativeConfigContext(request, context);
    let facts: ReferenceGraphFacts | undefined;
    if (observer === undefined) {
      facts = projectNativeReferenceFacts(context, request.context);
    } else {
      const scope = [
        'project',
        observer.project(input.context.configPath),
      ] as const;
      observer.metric(
        'graph.reference-facts.native.projection-attempts',
        scope,
        'calls',
        1,
      );
      facts = observer.sumElapsed(
        'graph.reference-facts.native.projection-elapsed-sum',
        scope,
        () => projectNativeReferenceFacts(context, request.context),
      );
    }
    if (facts === undefined) return adapterReferenceFacts(request);
    retainNativeObservation(request.caches, facts.nativeEvidence);
    memo?.set(key, { context, facts });
    request.caches?.analysisCache?.increment('nativeReferenceFactProjections');
    observer?.metric(
      'graph.reference-facts.native.projections',
      ['project', observer.project(input.context.configPath)],
      'calls',
      1,
    );
    return facts;
  } finally {
    fresh?.dispose();
  }
}

function adapterReferenceFacts(
  request: ProjectDependencyRequest,
): ReferenceGraphFacts {
  request.caches?.analysisCache?.increment('graphAdapterCollections');
  const observer = currentProfile();
  let collection: ProjectDependencyCollection;
  if (observer === undefined) {
    collection = collectProjectDependencies(request);
  } else {
    const scope = [
      'project',
      observer.project(request.context.configPath),
    ] as const;
    observer.metric(
      'graph.reference-facts.adapter.collections',
      scope,
      'calls',
      1,
    );
    collection = observer.sumElapsed(
      'graph.reference-facts.adapter.collection-elapsed-sum',
      scope,
      () => collectProjectDependencies(request),
    );
  }
  const references = effectiveReferenceInputs(collection);
  const roots = new Set(request.context.fileNames);
  return {
    declarationEvidence: collection.declarationEvidence,
    nativeEvidence: collection.nativeEvidence,
    dependencies: collection.dependencies,
    failures: collection.failures,
    observations: collection.observations,
    referenceInputs: references,
    ownershipInputs:
      collection.nativeEvidence === undefined
        ? references
        : collection.dependencies.filter(
            (dependency) =>
              roots.has(dependency.importRecord.filePath) ||
              dependency.referenceRequirement !== null,
          ),
    unresolvedNativeRecords: collection.nativeEvidence
      ? (collection.declarationClosure?.records ?? []).map((record) => ({
          record,
        }))
      : [],
  };
}
