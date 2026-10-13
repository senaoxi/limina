import type { VueProjectSemanticIdentity } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import { occurrenceKey } from '../analysis-cache/semantic-state';
import {
  createFrameworkSemanticEvidence,
  createFrameworkSemanticFailure,
} from '../framework-semantic/contracts';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import { resolveVueSemanticImport } from '../vue-semantic/resolution';
import type { ImportRecord } from './records';
import type {
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';

export function shouldUseVueSemanticResolution(options: {
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): boolean {
  const identity = options.request.context.vueSemanticIdentity;
  return (
    identity !== undefined &&
    identity.profilesByFileName.has(
      normalizeAbsolutePath(options.importRecord.filePath),
    )
  );
}

export function resolveVueSemanticPair(options: {
  identity: VueProjectSemanticIdentity;
  importRecord: ImportRecord;
  manager: VueSemanticContextManager | undefined;
  oxc: string | null;
}): ModuleResolutionPair {
  if (options.manager === undefined) {
    return {
      oxc: options.oxc,
      semanticFailure: createFrameworkSemanticFailure({
        framework: 'vue',
        reason:
          'Vue semantic module resolution is unavailable outside an analysis provider generation.',
        scopeIdentity: options.identity.id,
        stage: 'context-creation',
      }),
      typescript: null,
    };
  }
  let uncached: ModuleResolutionPair | undefined;
  const evidence = options.manager.query({
    identity: options.identity,
    kind: 'resolution',
    request: [
      options.importRecord.filePath,
      options.importRecord.line,
      occurrenceKey(options.importRecord),
    ],
    collect: () => {
      uncached = resolveUncachedVuePair({
        ...options,
        manager: options.manager!,
      });
      const semantic = uncached.semanticEvidence;
      if (semantic === undefined) return semantic;
      return {
        framework: semantic.framework,
        profile: semantic.profile,
        provenance: semantic.provenance,
        resolutionMode: semantic.resolutionMode,
        semanticSpecifier: semantic.semanticSpecifier,
        sourceRecord: semantic.sourceRecord,
        target: semantic.target,
      };
    },
  });
  return evidence === undefined
    ? uncached!
    : {
        oxc: options.oxc,
        semanticEvidence: { ...evidence, identityId: options.identity.id },
        typescript: evidence.target,
      };
}

function resolveUncachedVuePair(options: {
  identity: VueProjectSemanticIdentity;
  importRecord: ImportRecord;
  manager: VueSemanticContextManager;
  oxc: string | null;
}): ModuleResolutionPair {
  const semantic = resolveVueSemanticImport({
    identity: options.identity,
    importRecord: options.importRecord,
    manager: options.manager,
  });
  if (semantic.kind === 'unsupported') {
    return {
      oxc: options.oxc,
      semanticFailure: createFrameworkSemanticFailure({
        framework: 'vue',
        reason: semantic.reason,
        scopeIdentity: options.identity.id,
        stage: semantic.stage,
      }),
      typescript: null,
    };
  }
  return {
    oxc: options.oxc,
    semanticEvidence: createFrameworkSemanticEvidence({
      candidate: semantic.evidence,
      resolutionMode: semantic.resolutionMode,
      target: semantic.resolution,
    }),
    typescript: semantic.resolution,
  };
}
