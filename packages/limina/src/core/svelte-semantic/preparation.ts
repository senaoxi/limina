import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { FrameworkSemanticDependencyPreparation } from '../framework-semantic/contracts';
import { enumerateGeneratedSemanticDependencies } from '../framework-semantic/generated-dependencies';
import {
  mergePreparedDirectSourceRecords,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import { requiresReferenceStructure } from '../framework-semantic/prepared-type-evidence';
import { collectFrameworkSupportContributions } from '../framework-semantic/support-contributions';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import {
  createBoundedProgram,
  createGeneratedSemanticScript,
} from './generated-script';
import { resolveSvelteModuleOccurrence } from './module-resolution';
import { collectSvelteMappedCandidates } from './projection';
import { isSvelteTypeScriptSource } from './source-records';
import type { SvelteSemanticToolchain } from './toolchain';
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
  generated: Parameters<typeof createBoundedProgram>[0]['generated'];
  project: SvelteSemanticProject;
  resolved: Extract<
    ReturnType<typeof collectSvelteMappedCandidates>,
    { kind: 'supported' }
  >['resolved'];
  toolchain: SvelteSemanticToolchain;
}): ts.Program | undefined {
  return options.supportInputBoundary !== undefined ||
    options.resolved.some((item) => requiresReferenceStructure(item.target))
    ? createBoundedProgram(options)
    : undefined;
}

function prepareProjectedCandidates(options: {
  supportInputBoundary?: WorkspaceSourceBoundary;
  directSourceRecords: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['directSourceRecords'];
  generated: Parameters<typeof createBoundedProgram>[0]['generated'];
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
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'svelte-check',
    framework: 'svelte',
    managedOutputLookup: options.managedOutputLookup,
    getProgram,
    resolved: options.resolved,
    tsModule: options.toolchain.tsModule,
  });
  if (prepared.kind === 'unsupported') return prepared;
  return {
    directSourceRecords: direct.records,
    facts: [...prepared.facts, ...supportContributions(options, getProgram)],
    kind: 'supported',
    unmapped: options.unmapped,
  };
}

function prepareUnchecked(options: {
  supportInputBoundary?: WorkspaceSourceBoundary;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: SvelteSemanticProject;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
}): FrameworkSemanticDependencyPreparation {
  const filePath = normalizeAbsolutePath(options.filePath);
  const generatedOutput = options.toolchain.transform(options.sourceText, {
    filename: filePath,
    isTsFile: isSvelteTypeScriptSource(options.sourceText),
    parse: options.toolchain.compiler.parse as never,
    version: options.toolchain.compilerVersion,
  });
  const generated = createGeneratedSemanticScript({
    filePath,
    generated: generatedOutput,
    project: options.project,
    toolchain: options.toolchain,
  });
  const dependencies = enumerateGeneratedSemanticDependencies({
    generatedFilePath: generated.filePath,
    sourceFile: generated.sourceFile,
    tsModule: options.toolchain.tsModule,
  });
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
  return prepareProjectedCandidates({
    supportInputBoundary: options.supportInputBoundary,
    directSourceRecords,
    generated,
    managedOutputLookup: options.managedOutputLookup,
    project: options.project,
    resolved: projected.resolved,
    toolchain: options.toolchain,
    unmapped,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareSvelteSemanticDependencies(options: {
  supportInputBoundary?: WorkspaceSourceBoundary;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: SvelteSemanticProject;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
}): FrameworkSemanticDependencyPreparation {
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
) {
  const boundary = options.supportInputBoundary;
  if (boundary === undefined) return [];
  return collectFrameworkSupportContributions({
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
