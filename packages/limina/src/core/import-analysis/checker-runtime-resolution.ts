import { createAstroCheckerResolution } from '../astro-semantic/resolution-candidate';
import type { FrameworkSemanticKind } from '../framework-semantic/contracts';
import { resolveFrameworkRuntimeOccurrence } from '../framework-semantic/runtime-dependencies';
import { createSvelteModuleTarget } from '../svelte-semantic/module-resolution';
import { isModuleImportRecord } from '../typescript-semantic/import-record';
import { lockedCheckerEvidence } from './checker-resolution-provider';
import type { ProviderDependencies } from './resolution-provider-types';
import type { ImportAnalysisContext, ModuleResolutionPair } from './types';

type RuntimeResolver = NonNullable<
  ImportAnalysisContext['resolveCheckerRuntimeImportEvidence']
>;
type RuntimeOptions = Parameters<RuntimeResolver>[0];

function runtimeAdapter(
  dependencies: ProviderDependencies,
  options: RuntimeOptions,
  framework: Exclude<FrameworkSemanticKind, 'vue'>,
):
  | Omit<Parameters<typeof resolveFrameworkRuntimeOccurrence>[0], 'occurrence'>
  | undefined {
  if (framework === 'astro') {
    const project = options.context.astroSemanticProject;
    if (project === undefined) return undefined;
    const context = dependencies.astroSemanticContexts?.acquire(project);
    if (context === undefined) return undefined;
    return {
      compiler: context.toolchain.tsModule,
      compilerRequests: context.compilerRequests,
      program: context.program,
      resolve: context.resolveRuntimeModule,
      target: (resolvedModule) =>
        createAstroCheckerResolution({
          project: context.project,
          resolvedModule,
        }),
    };
  }
  const project = options.context.svelteSemanticProject;
  if (project === undefined) return undefined;
  const context = dependencies.svelteSemanticContexts?.acquire(project);
  if (context === undefined) return undefined;
  const bounded = context.boundedProgram;
  return {
    compiler: context.toolchain.tsModule,
    compilerRequests: bounded.compilerRequests,
    program: bounded.program,
    resolve: bounded.resolveRuntimeModule,
    target: (resolved) =>
      createSvelteModuleTarget(resolved, context.toolchain.tsModule)!,
  };
}

function resolveRuntimePair(
  dependencies: ProviderDependencies,
  options: RuntimeOptions,
  framework: Exclude<FrameworkSemanticKind, 'vue'>,
): ModuleResolutionPair {
  const { importRecord, context } = options;
  const identityId =
    context.astroSemanticProject?.seed.id ??
    context.svelteSemanticProject?.configPath ??
    context.configPath ??
    importRecord.filePath;
  try {
    const adapter = runtimeAdapter(dependencies, options, framework);
    if (adapter === undefined)
      return {
        oxc: null,
        semanticFailure: {
          framework,
          reason:
            'The locked checker has no runtime module resolution context.',
          scopeIdentity: identityId,
          stage: 'context-creation',
        },
        typescript: null,
      };
    const { resolutionMode, target } = resolveFrameworkRuntimeOccurrence({
      ...adapter,
      occurrence: importRecord,
    });
    return {
      oxc: null,
      semanticEvidence: {
        framework,
        identityId,
        provenance: 'direct-source',
        resolutionMode,
        semanticSpecifier: importRecord.specifier,
        sourceRecord: importRecord,
        target,
      },
      typescript: target,
    };
  } catch (error) {
    return {
      oxc: null,
      semanticFailure: {
        framework,
        reason: error instanceof Error ? error.message : String(error),
        scopeIdentity: identityId,
        stage: 'module-resolution',
      },
      typescript: null,
    };
  }
}

function isDirectFrameworkImport(
  framework: RuntimeOptions['context']['semanticFamily'],
  record: RuntimeOptions['importRecord'],
): framework is Exclude<FrameworkSemanticKind, 'vue'> {
  return (
    (framework === 'astro' || framework === 'svelte') &&
    record.domain === 'typescript' &&
    record.kind !== 'module-augmentation' &&
    isModuleImportRecord(record)
  );
}

export function createCheckerRuntimeResolver(
  dependencies: ProviderDependencies,
): RuntimeResolver {
  return (options) => {
    const framework = options.context.semanticFamily;
    let evidence: ReturnType<RuntimeResolver>;
    if (isDirectFrameworkImport(framework, options.importRecord)) {
      dependencies.requests.recordRequest('typescript');
      evidence = lockedCheckerEvidence(
        resolveRuntimePair(dependencies, options, framework),
        {
          compilerOptions: options.compilerOptions,
          containingFile: options.importRecord.filePath,
          context: options.context,
        },
        options.importRecord,
      );
    }
    return evidence;
  };
}
