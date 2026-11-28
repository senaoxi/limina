import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { frameworkCompilationObligation } from '../framework-semantic/compilation-obligation';
import type {
  FrameworkSemanticDependencyPreparation,
  PreparedDependencyFact,
} from '../framework-semantic/contracts';
import { enumerateGeneratedSemanticDependencies } from '../framework-semantic/generated-dependencies';
import {
  mergePreparedDirectSourceRecords,
  mergePreparedRuntimeFacts,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import { requiresReferenceStructure } from '../framework-semantic/prepared-type-evidence';
import { collectGeneratedRuntimeFacts } from '../framework-semantic/runtime-dependencies';
import { collectFrameworkSupportContributions } from '../framework-semantic/support-contributions';
import { buildLineStarts } from '../import-analysis/records';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import {
  createBoundedProgram,
  createGeneratedSemanticScript,
  type GeneratedSemanticScript,
} from './generated-script';
import {
  createSvelteModuleTarget,
  resolveSvelteModuleOccurrence,
} from './module-resolution';
import {
  collectSvelteMappedCandidates,
  createSvelteMappedSourceRecord,
} from './projection';
import { mapGeneratedRange } from './source-mapping';
import type { SvelteSemanticToolchain } from './toolchain';
import {
  type SvelteTransformCache,
  transformSvelteComponent,
} from './transform';
import type { SvelteSemanticProject } from './types';

function createIdentity(options: {
  project: SvelteSemanticProject;
  toolchain: SvelteSemanticToolchain;
}): string {
  return JSON.stringify({
    adapterVersion: options.project.adapterVersion,
    compilerPath: options.toolchain.compilerPath,
    compilerVersion: options.toolchain.compilerVersion,
    configPath: options.project.configPath,
    configClosure: options.project.configClosure,
    packageIdentity: options.project.packageIdentity,
    compilerOptions: options.project.options,
    executionConfig: options.project.resolverConfigPath,
    executionFiles:
      options.project.virtualFiles === undefined
        ? undefined
        : [...options.project.virtualFiles],
    references: options.project.references,
    svelteOptions: options.project.svelteOptions,
    generation: options.project.generation,
    transformPath: options.toolchain.transformPath,
    transformVersion: options.toolchain.transformVersion,
    typeScriptPath: options.toolchain.typeScriptPath,
    typeScriptVersion: options.toolchain.typeScriptVersion,
  });
}

function createFailure(
  reason: string,
  stage: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'unsupported' }
  >['stage'],
): FrameworkSemanticDependencyPreparation {
  return { kind: 'unsupported', reason, stage };
}

function getStructuralProgram(options: {
  supportInputBoundary?: WorkspaceSourceBoundary;
  generated: GeneratedSemanticScript;
  project: SvelteSemanticProject;
  resolved: Extract<
    ReturnType<typeof collectSvelteMappedCandidates>,
    { kind: 'supported' }
  >['resolved'];
  toolchain: SvelteSemanticToolchain;
}): ts.Program | undefined {
  return options.supportInputBoundary !== undefined ||
    options.resolved.some((item) => requiresReferenceStructure(item.target))
    ? createBoundedProgram(options).program
    : undefined;
}

function prepareProjectedCandidates(options: {
  supportInputBoundary?: WorkspaceSourceBoundary;
  directSourceRecords: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['directSourceRecords'];
  generated: GeneratedSemanticScript;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: SvelteSemanticProject;
  resolved: Extract<
    ReturnType<typeof collectSvelteMappedCandidates>,
    { kind: 'supported' }
  >['resolved'];
  toolchain: SvelteSemanticToolchain;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): FrameworkSemanticDependencyPreparation {
  const direct = mergePreparedDirectSourceRecords(options.directSourceRecords);
  if (direct.kind === 'unsupported') return direct;
  let program: ts.Program | undefined;
  const getProgram = () => (program ??= getStructuralProgram(options));
  if (
    options.resolved.some(
      (item) =>
        item.target === null && item.compilationObligation?.state === 'unknown',
    )
  )
    return createFailure(
      'Svelte compiler request has no qualified resolution observation.',
      'toolchain-compatibility',
    );
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'svelte-check',
    framework: 'svelte',
    managedOutputLookup: options.managedOutputLookup,
    getProgram,
    resolved: options.resolved,
    tsModule: options.toolchain.tsModule,
  });
  if (prepared.kind === 'unsupported') return prepared;
  const support = supportContributions(options, getProgram, prepared.facts);
  return {
    declarationClosure: support.closure,
    directSourceRecords: direct.records,
    facts: [...prepared.facts, ...support.facts],
    kind: 'supported',
    unmapped: options.unmapped,
  };
}

interface SveltePreparationOptions {
  supportInputBoundary?: WorkspaceSourceBoundary;
  filePath: string;
  includeRuntimeOnly?: boolean;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: SvelteSemanticProject;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
  transforms?: SvelteTransformCache;
}

function prepareUnchecked(
  options: SveltePreparationOptions,
): FrameworkSemanticDependencyPreparation {
  const filePath = normalizeAbsolutePath(options.filePath);
  const generatedOutput = transformSvelteComponent(
    filePath,
    options.sourceText,
    options.project.svelteOptions?.namespace,
    options.toolchain,
    options.transforms,
  );
  const generated = createGeneratedSemanticScript({
    filePath,
    generated: generatedOutput,
    project: options.project,
    toolchain: options.toolchain,
  });
  const bounded = createBoundedProgram({ ...options, generated });
  const { program } = bounded;
  const requests = generated.compilerRequests.collect(
    program,
    generated.sourceFile,
  );
  const dependencies = [
    ...requests,
    ...enumerateGeneratedSemanticDependencies({
      generatedFilePath: generated.filePath,
      sourceFile: generated.sourceFile,
      tsModule: options.toolchain.tsModule,
    }).filter((dependency) => dependency.literal === null),
  ];
  const directSourceRecords: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['directSourceRecords'] = [];
  const unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'] = [];
  const projected = collectSvelteMappedCandidates({
    dependencies,
    directSourceRecords,
    generated,
    identity: createIdentity(options),
    project: options.project,
    sourceFilePath: filePath,
    sourceText: options.sourceText,
    toolchain: options.toolchain,
    unmapped,
  });
  if (projected.kind === 'unsupported') return projected;
  if (
    !options.project.options.noResolve &&
    projected.resolved.some(
      (item) =>
        item.candidate.sourceRecord.compilerRequest?.role === 'import' &&
        item.target?.resolvedBy === 'checker-source' &&
        item.candidate.provenance === 'compiler-request',
    )
  )
    return createFailure(
      'Svelte generated component consumption has no qualified source association.',
      'toolchain-compatibility',
    );
  const preparation = prepareProjectedCandidates({
    supportInputBoundary: options.supportInputBoundary,
    directSourceRecords,
    generated,
    managedOutputLookup: options.managedOutputLookup,
    project: options.project,
    resolved: projected.resolved.map((item) => ({
      ...item,
      ...(!(
        !options.project.options.noResolve &&
        item.candidate.sourceRecord.compilerRequest?.role === 'import' &&
        item.target?.resolvedBy === 'checker-source' &&
        item.candidate.provenance === 'strict-source-map'
      ) && {
        target: createSvelteModuleTarget(
          requests.find((request) => request.literal === item.candidate.literal)
            ?.raw?.resolvedModule,
          options.toolchain.tsModule,
        ),
        resolutionMode: String(
          requests.find((request) => request.literal === item.candidate.literal)
            ?.mode,
        ),
      }),
      // Component schedules retain the adapter's source-consumption contract;
      // a TypeScript declaration surrogate is not a native implementation input.
      compilationObligation:
        !options.project.options.noResolve &&
        item.candidate.sourceRecord.compilerRequest?.role === 'import' &&
        item.target?.resolvedBy === 'checker-source' &&
        item.candidate.provenance === 'strict-source-map'
          ? undefined
          : frameworkCompilationObligation(
              {
                program,
                tsModule: options.toolchain.tsModule,
                compilerRequests: generated.compilerRequests,
                configPath: options.project.configPath,
              },
              requests.filter(
                (request) => request.literal === item.candidate.literal,
              ),
            ),
    })),
    toolchain: options.toolchain,
    unmapped,
  });
  if (!options.includeRuntimeOnly || preparation.kind === 'unsupported')
    return preparation;
  const sourceLineStarts = buildLineStarts(options.sourceText);
  const runtime = collectGeneratedRuntimeFacts({
    framework: 'svelte',
    compiler: options.toolchain.tsModule,
    compilerRequests: generated.compilerRequests,
    program,
    resolve: bounded.resolveRuntimeModule,
    source: generated.sourceFile,
    target: (resolved) =>
      createSvelteModuleTarget(resolved, options.toolchain.tsModule)!,
    projectOccurrence: (dependency) => {
      const mapped = mapGeneratedRange({
        generatedLineStarts: generated.lineStarts,
        generatedRecord: dependency.record,
        sourceFilePath: filePath,
        sourceLineStarts,
        trace: generated.trace,
      });
      return mapped.kind === 'mapped'
        ? {
            kind: 'mapped',
            sourceRecord: createSvelteMappedSourceRecord({
              generatedRecord: dependency.record,
              range: mapped.range,
              sourceFilePath: filePath,
              sourceText: options.sourceText,
            }),
          }
        : mapped;
    },
  });
  if (runtime.kind === 'unsupported') return runtime;
  const merged = mergePreparedRuntimeFacts('svelte', runtime.facts);
  return merged.kind === 'supported'
    ? { ...preparation, facts: [...preparation.facts, ...merged.facts] }
    : merged;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareSvelteSemanticDependencies(
  options: SveltePreparationOptions,
): FrameworkSemanticDependencyPreparation {
  try {
    return prepareUnchecked(options);
  } catch (error) {
    return createFailure(
      `Svelte semantic service-script materialization failed: ${formatError(error)}`,
      'service-script-materialization',
    );
  }
}

function supportContributions(
  options: Parameters<typeof prepareProjectedCandidates>[0],
  getProgram: () => ts.Program | undefined,
  entryFacts: PreparedDependencyFact[],
) {
  const boundary = options.supportInputBoundary;
  if (boundary === undefined) return { facts: [], closure: undefined };
  return collectFrameworkSupportContributions({
    configPath: options.project.configPath,
    entryFacts,
    boundary,
    checkerName: 'svelte-check',
    framework: 'svelte',
    identity: createIdentity(options),
    managedOutputLookup: options.managedOutputLookup,
    program: getProgram()!,
    rootNames: [...options.project.fileNames, options.generated.filePath],
    tsModule: options.toolchain.tsModule,
    resolutionHost: options.generated.resolutionHost,
    resolve: (candidate) =>
      resolveSvelteModuleOccurrence({
        literal: candidate.literal,
        sourceFile: candidate.containingSourceFile,
        host: options.generated.resolutionHost,
        cache: options.generated.resolutionCache,
        project: options.project,
        tsModule: options.toolchain.tsModule,
      }),
  });
}
