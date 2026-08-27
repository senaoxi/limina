import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { FrameworkSemanticDependencyPreparation } from '../framework-semantic/contracts';
import { enumerateGeneratedSemanticDependencies } from '../framework-semantic/generated-dependencies';
import {
  mergePreparedDirectSourceRecords,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import {
  createBoundedProgram,
  createGeneratedSemanticScript,
} from './generated-script';
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

function getEvidenceProgram(options: {
  generated: Parameters<typeof createBoundedProgram>[0]['generated'];
  project: SvelteSemanticProject;
  resolved: Extract<
    ReturnType<typeof collectSvelteMappedCandidates>,
    { kind: 'supported' }
  >['resolved'];
  toolchain: SvelteSemanticToolchain;
}): ts.Program | undefined {
  return options.resolved.some((item) => item.target === null)
    ? createBoundedProgram(options)
    : undefined;
}

function prepareProjectedCandidates(options: {
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
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'svelte-check',
    framework: 'svelte',
    managedOutputLookup: options.managedOutputLookup,
    program: getEvidenceProgram(options),
    resolved: options.resolved,
    tsModule: options.toolchain.tsModule,
  });
  if (prepared.kind === 'unsupported') return prepared;
  return {
    directSourceRecords: direct.records,
    facts: prepared.facts,
    kind: 'supported',
    unmapped: options.unmapped,
  };
}

function prepareUnchecked(options: {
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
