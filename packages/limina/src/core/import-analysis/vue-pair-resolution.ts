import type { VueProjectSemanticIdentity } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
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
  if (identity === undefined) return false;
  return identity.profilesByFileName.has(
    normalizeAbsolutePath(options.importRecord.filePath),
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
