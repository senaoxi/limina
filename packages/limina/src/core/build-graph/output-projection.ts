import type ts from 'typescript';
import { analysisHash, nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import {
  createTypeScriptDependencyContext,
  createWorkspaceSourceBoundary,
} from '../typescript-semantic';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { SourceProject } from './types';
// Independent of config-type-directives receipts: covers output governance.
export interface OutputProjectionReceipt {
  scope: 'existing-output-relations';
  version: 1;
  sourceConfig: string;
  generatedConfig: string;
  sourceTarget: number | null;
  outputTarget: number | null;
  contextId: string | null;
  optionsVersion: string;
  roots: string[];
  covered: { file: string; owner: string; outputConfig: string }[];
}
interface ProjectionInput {
  project: SourceProject;
  state: GeneratedGraphPreparationState;
  cache?: NativeAnalysisCache;
}
function dependencies(
  context: TypeScriptSemanticDependencyContext,
): Map<string, string> {
  const targets = new Map<string, string>();
  const files = contributionFiles(context);
  for (const file of files) addFileTargets(context, file, targets);
  return targets;
}
function addFileTargets(
  context: TypeScriptSemanticDependencyContext,
  file: string,
  targets: Map<string, string>,
): void {
  const records = context.getImportRecords(file);
  for (const record of records) {
    const requirement = context.getDependencyFact(record).referenceRequirement;
    if (requirement !== null) targets.set(requirement.targetFileName, file);
  }
}
function outputOptions(project: SourceProject): ts.CompilerOptions {
  const receipt = project.typeInputProjections?.findLast(
    (input) => input.generatedConfig === project.outputConfigPath,
  );
  if (receipt === undefined)
    throw new Error(
      `Output options were not observed: ${project.outputConfigPath}`,
    );
  return effectiveCompilerOptions(receipt.generatedOptions);
}
function outputContext(
  project: SourceProject,
  owners: Map<string, SourceProject>,
): TypeScriptSemanticProject {
  return {
    configPath: project.outputConfigPath,
    options: outputOptions(project),
    fileNames: project.fileNames,
    analysisBinding: {
      phase: 'locked',
      checker: `${project.checkerName}:output`,
    },
    admissionMode: 'full-program',
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      owners.keys().toArray(),
    ),
  };
}
function baseReceipt(
  project: SourceProject,
  output: TypeScriptSemanticProject,
): OutputProjectionReceipt {
  return {
    scope: 'existing-output-relations',
    version: 1,
    sourceConfig: project.configPath,
    generatedConfig: project.outputConfigPath,
    sourceTarget: project.options.target ?? null,
    outputTarget: output.options.target ?? null,
    optionsVersion: analysisHash(output.options),
    roots: [...project.fileNames],
    contextId: null,
    covered: [],
  };
}
function frameworkReceipt(
  project: SourceProject,
  receipt: OutputProjectionReceipt,
): OutputProjectionReceipt {
  if (receipt.sourceTarget !== receipt.outputTarget)
    throw new Error(
      `Output projection capability is incomplete for ${project.semanticAuthority.family}: ${project.configPath} -> outputs.target -> ${project.outputConfigPath}`,
    );
  return receipt;
}
function foreignOwner(
  owners: Map<string, SourceProject>,
  target: string,
  project: SourceProject,
): SourceProject | undefined {
  const owner = owners.get(target);
  return owner?.configPath === project.configPath ? undefined : owner;
}
function coveredTarget(
  project: SourceProject,
  owner: SourceProject,
  input: { target: string; contributor: string },
): OutputProjectionReceipt['covered'][number] {
  if (!project.outputReferences.has(owner.outputConfigPath))
    throw new Error(
      `Output projection capability is incomplete: an output dependency is not covered by existing output references.\n  ${project.configPath} -> outputs.target -> ${input.contributor} -> ${input.target}\n  owner: ${owner.configPath}`,
    );
  return {
    file: input.target,
    owner: owner.configPath,
    outputConfig: owner.outputConfigPath,
  };
}
function coverDependencies(
  project: SourceProject,
  owners: Map<string, SourceProject>,
  context: TypeScriptSemanticDependencyContext,
): OutputProjectionReceipt['covered'] {
  const covered: OutputProjectionReceipt['covered'] = [];
  const targets = dependencies(context);
  for (const [target, contributor] of targets) {
    const owner = foreignOwner(owners, target, project);
    if (owner !== undefined)
      covered.push(coveredTarget(project, owner, { target, contributor }));
  }
  return covered;
}
function disposeContext(context: TypeScriptSemanticDependencyContext): void {
  if ('dispose' in context && typeof context.dispose === 'function')
    context.dispose();
}
function nativeReceipt(
  input: ProjectionInput,
  output: TypeScriptSemanticProject,
  owners: Map<string, SourceProject>,
): OutputProjectionReceipt {
  const context =
    input.cache?.restoreContext(output) ??
    createTypeScriptDependencyContext(output, { analysisCache: input.cache });
  try {
    return {
      ...baseReceipt(input.project, output),
      contextId: nativeContextId(output),
      covered: coverDependencies(input.project, owners, context),
    };
  } finally {
    disposeContext(context);
  }
}
export function proveOutputProjection(
  input: ProjectionInput,
): OutputProjectionReceipt {
  const projects = input.state.projectsByChecker.values().toArray().flat();
  const owners = new Map(
    projects.flatMap((owner) =>
      owner.ownedFileNames.map((file) => [file, owner] as const),
    ),
  );
  const output = outputContext(input.project, owners);
  return input.project.semanticAuthority.family === 'typescript'
    ? nativeReceipt(input, output, owners)
    : frameworkReceipt(input.project, baseReceipt(input.project, output));
}
function isValidContext(
  receipt: OutputProjectionReceipt,
  cache: NativeAnalysisCache,
  id: string,
): boolean {
  const context = cache.contexts[id];
  if (!context?.complete) return false;
  return [
    analysisHash(context.project.options) === receipt.optionsVersion,
    analysisHash(context.project.fileNames) === analysisHash(receipt.roots),
    context.dependencies.every((dependency) => cache.inputs.valid(dependency)),
  ].every(Boolean);
}
export function isValidOutputProjection(
  receipt: OutputProjectionReceipt,
  cache: NativeAnalysisCache,
): boolean {
  if (
    ![
      receipt.scope === 'existing-output-relations',
      receipt.version === 1,
    ].every(Boolean)
  )
    return false;
  return receipt.contextId === null
    ? receipt.sourceTarget === receipt.outputTarget
    : isValidContext(receipt, cache, receipt.contextId);
}

function contributionFiles(
  context: TypeScriptSemanticDependencyContext,
): readonly string[] {
  return context.getContributionFileNames?.() ?? [];
}
