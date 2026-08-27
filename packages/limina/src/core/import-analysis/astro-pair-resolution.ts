import path from 'node:path';
import { resolveAstroSemanticImport } from '../astro-semantic/resolution';
import {
  createFrameworkSemanticFailure,
  type FrameworkSemanticFailure,
} from '../framework-semantic/contracts';
import type { ImportRecord } from './records';
import type { ProviderDependencies } from './resolution-provider-types';
import type {
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';

function toPortableRelativePath(from: string, to: string): string {
  return path.relative(from, to).replaceAll(path.sep, '/');
}

const rootAstroFailureStages = new Set<FrameworkSemanticFailure['stage']>([
  'context-creation',
  'toolchain-compatibility',
  'toolchain-resolution',
]);

function createAstroFailureScopeIdentity(options: {
  importRecord: ImportRecord;
  project: NonNullable<
    NormalizedModuleResolutionRequest['context']['astroSemanticProject']
  >;
  stage: FrameworkSemanticFailure['stage'];
}): string {
  const rootIdentity = {
    configPath: toPortableRelativePath(
      options.project.seed.packageRootDir,
      options.project.seed.configPath,
    ),
    framework: 'astro',
    owner: 'leaf',
  };
  if (rootAstroFailureStages.has(options.stage)) {
    return JSON.stringify(rootIdentity);
  }
  return JSON.stringify({
    ...rootIdentity,
    domain: options.importRecord.domain,
    filePath: toPortableRelativePath(
      options.project.seed.packageRootDir,
      options.importRecord.filePath,
    ),
    kind: options.importRecord.kind,
    locator: options.importRecord.locator,
    specifier: options.importRecord.specifier,
  });
}

function createAstroUnavailablePair(options: {
  importRecord: ImportRecord;
  oxc: string | null;
  project: NonNullable<
    NormalizedModuleResolutionRequest['context']['astroSemanticProject']
  >;
}): ModuleResolutionPair {
  return {
    oxc: options.oxc,
    semanticFailure: createFrameworkSemanticFailure({
      framework: 'astro',
      reason:
        'Astro semantic module resolution is unavailable outside an analysis provider generation.',
      scopeIdentity: createAstroFailureScopeIdentity({
        importRecord: options.importRecord,
        project: options.project,
        stage: 'context-creation',
      }),
      stage: 'context-creation',
    }),
    typescript: null,
  };
}

function getAstroFailureScopeIdentity(options: {
  importRecord: ImportRecord;
  project: NonNullable<
    NormalizedModuleResolutionRequest['context']['astroSemanticProject']
  >;
  scopeIdentity: string | undefined;
  stage: FrameworkSemanticFailure['stage'];
}): string {
  if (options.scopeIdentity !== undefined) return options.scopeIdentity;
  return createAstroFailureScopeIdentity(options);
}

export function resolveAstroSemanticPair(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  oxc: string | null;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  const project = options.request.context.astroSemanticProject!;
  if (options.dependencies.astroSemanticContexts === undefined) {
    return createAstroUnavailablePair({
      importRecord: options.importRecord,
      oxc: options.oxc,
      project,
    });
  }
  const semantic = resolveAstroSemanticImport({
    importRecord: options.importRecord,
    manager: options.dependencies.astroSemanticContexts,
    metrics: options.dependencies.metrics,
    project,
  });
  if (semantic.kind === 'unsupported') {
    return {
      oxc: options.oxc,
      semanticFailure: createFrameworkSemanticFailure({
        framework: 'astro',
        reason: semantic.reason,
        scopeIdentity: getAstroFailureScopeIdentity({
          importRecord: options.importRecord,
          project,
          scopeIdentity: semantic.scopeIdentity,
          stage: semantic.stage,
        }),
        stage: semantic.stage,
      }),
      typescript: null,
    };
  }
  return {
    oxc: options.oxc,
    semanticEvidence: semantic.evidence,
    typescript: semantic.resolution,
  };
}
