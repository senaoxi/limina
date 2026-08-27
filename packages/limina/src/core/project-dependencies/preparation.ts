import { normalizeAbsolutePath } from '#utils/path';
import {
  cloneProjectDependencyPreparation,
  createProjectSemanticCacheIdentity,
} from './cache';
import type {
  ProjectDependencyPreparation,
  ProjectDependencyRequest,
  SourceEvidence,
} from './contracts';
import {
  collectPreparedProjectDependencyFact,
  collectProjectDependencyRecord,
} from './dependency-record';
import {
  createPreparationFailureIdentity,
  createProjectDependencyFailure,
  mapFailureStage,
} from './failure';
import {
  collectFileSourceEvidence,
  createFileRequest,
  type FilePreparationOptions,
  requiresGeneratedSemanticPreparation,
} from './preparation-source';
import { isTypeScriptSemanticSource } from './source-evidence';

function getCachedPreparation(options: {
  base: FilePreparationOptions;
  cacheKey: string;
}): ProjectDependencyPreparation | undefined {
  const cached =
    options.base.request.caches?.projectDependencyPreparationCache.get(
      options.cacheKey,
    );
  if (cached === undefined) return undefined;
  const preparation = cloneProjectDependencyPreparation(cached);
  options.base.collection.failures.push(...preparation.failures);
  options.base.collection.observations.push(...preparation.observations);
  return preparation;
}

function finishPreparation(options: {
  base: FilePreparationOptions;
  cacheKey: string;
  directSourceRecords: ProjectDependencyPreparation['directSourceRecords'];
  failureStart: number;
  observationStart: number;
  facts: ProjectDependencyPreparation['facts'];
  ready: boolean;
}): ProjectDependencyPreparation {
  const preparation = {
    directSourceRecords: options.directSourceRecords,
    failures: options.base.collection.failures.slice(options.failureStart),
    facts: options.facts,
    observations: options.base.collection.observations.slice(
      options.observationStart,
    ),
    ready: options.ready,
  };
  options.base.request.caches?.projectDependencyPreparationCache.set(
    options.cacheKey,
    cloneProjectDependencyPreparation(preparation),
  );
  return preparation;
}

type PreparationFinisher = (
  ready: boolean,
  directSourceRecords: ProjectDependencyPreparation['directSourceRecords'],
  facts?: ProjectDependencyPreparation['facts'],
) => ProjectDependencyPreparation;

function createPreparationFinisher(options: {
  base: FilePreparationOptions;
  cacheKey: string;
  failureStart: number;
  observationStart: number;
}): PreparationFinisher {
  return (ready, directSourceRecords, facts = []) =>
    finishPreparation({ ...options, directSourceRecords, facts, ready });
}

function getPreparationSource(options: {
  base: FilePreparationOptions;
  requiresGeneratedPreparation: boolean;
}): SourceEvidence | undefined {
  return options.requiresGeneratedPreparation
    ? undefined
    : collectFileSourceEvidence(options.base);
}

function hasSourceDiagnostics(source: SourceEvidence | undefined): boolean {
  return source !== undefined && source.diagnostics.length > 0;
}

function canUseDirectSource(options: {
  fileName: string;
  requiresGeneratedPreparation: boolean;
  source: SourceEvidence | undefined;
}): boolean {
  if (options.source === undefined) return false;
  if (isTypeScriptSemanticSource(options.fileName)) return true;
  return !options.requiresGeneratedPreparation;
}

function prepareGeneratedSource(options: {
  base: FilePreparationOptions;
  finish: PreparationFinisher;
  source: SourceEvidence | undefined;
}): ProjectDependencyPreparation {
  const semantic = prepareGeneratedSemanticDependencies(options);
  if (semantic.kind === 'unsupported') {
    addGeneratedPreparationFailure(options.base, semantic);
    return options.finish(false, []);
  }
  addGeneratedObservations(options.base, semantic.unmapped);
  return options.finish(true, semantic.directSourceRecords, semantic.facts);
}

function prepareGeneratedSemanticDependencies(options: {
  base: FilePreparationOptions;
  source: SourceEvidence | undefined;
}) {
  return options.base.request.importAnalysis.prepareCheckerSemanticDependencies(
    {
      context: {
        astroSemanticProject: options.base.request.context.astroSemanticProject,
        checkerPresets: [],
        configPath: options.base.request.context.configPath,
        extensions: [...options.base.request.context.extensions],
        resolverConfigPath: options.base.request.context.resolverConfigPath,
        semanticFamily: options.base.request.context.semanticAuthority.family,
        svelteSemanticProject:
          options.base.request.context.svelteSemanticProject,
        vueSemanticIdentity: options.base.request.context.vueSemanticIdentity,
      },
      filePath: options.base.fileName,
      managedOutputLookup: options.base.request.managedOutputLookup,
    },
  );
}

function addGeneratedPreparationFailure(
  base: FilePreparationOptions,
  semantic: Extract<
    ReturnType<
      FilePreparationOptions['request']['importAnalysis']['prepareCheckerSemanticDependencies']
    >,
    { kind: 'unsupported' }
  >,
): void {
  base.collection.failures.push(
    createProjectDependencyFailure({
      identity: createPreparationFailureIdentity({
        fileName: base.fileName,
        request: base.request,
        stage: semantic.stage,
      }),
      reason: semantic.reason,
      request: base.request,
      stage: mapFailureStage(semantic.stage),
    }),
  );
}

function addGeneratedObservations(
  base: FilePreparationOptions,
  unmapped: readonly { generatedFilePath: string; semanticSpecifier: string }[],
): void {
  base.collection.observations.push(
    ...unmapped.map((observation) => ({
      ...observation,
      kind: 'unmapped-generated' as const,
    })),
  );
}

function prepareUncachedProjectFile(options: {
  base: FilePreparationOptions;
  finish: PreparationFinisher;
}): ProjectDependencyPreparation {
  const requiresGeneratedPreparation = requiresGeneratedSemanticPreparation(
    options.base,
  );
  const source = getPreparationSource({
    base: options.base,
    requiresGeneratedPreparation,
  });
  if (hasSourceDiagnostics(source)) return options.finish(false, []);
  if (
    canUseDirectSource({
      fileName: options.base.fileName,
      requiresGeneratedPreparation,
      source,
    })
  ) {
    return options.finish(true, source!.records);
  }
  return prepareGeneratedSource({ ...options, source });
}

function prepareProjectFile(
  options: FilePreparationOptions,
): ProjectDependencyPreparation {
  const failureStart = options.collection.failures.length;
  const observationStart = options.collection.observations.length;
  const cacheKey = JSON.stringify({
    fileName: normalizeAbsolutePath(options.fileName),
    project: createProjectSemanticCacheIdentity(options.request.context),
    stage: 'generated-dependency-preparation',
  });
  const base = { base: options, cacheKey, failureStart, observationStart };
  const cached = getCachedPreparation(base);
  if (cached !== undefined) return cached;
  return prepareUncachedProjectFile({
    base: options,
    finish: createPreparationFinisher(base),
  });
}

export function collectProjectDependencyFile(
  options: FilePreparationOptions,
): void {
  const request = createFileRequest(options.request, options.fileName);
  const preparation = prepareProjectFile({ ...options, request });
  if (!preparation.ready) return;
  collectDirectRecords({ options, preparation, request });
  collectPreparedFacts({ options, preparation, request });
}

function collectDirectRecords(options: {
  options: FilePreparationOptions;
  preparation: ProjectDependencyPreparation;
  request: ProjectDependencyRequest;
}): void {
  for (const importRecord of options.preparation.directSourceRecords) {
    collectProjectDependencyRecord({
      ...options.options,
      importRecord,
      request: options.request,
    });
  }
}

function collectPreparedFacts(options: {
  options: FilePreparationOptions;
  preparation: ProjectDependencyPreparation;
  request: ProjectDependencyRequest;
}): void {
  for (const fact of options.preparation.facts) {
    collectPreparedProjectDependencyFact({
      ...options.options,
      fact,
      request: options.request,
    });
  }
}
