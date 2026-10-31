import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import { analysisHash, nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { createTypeScriptDependencyContext } from '../typescript-semantic';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { projectNativeDeclarationClosure } from '../typescript-semantic/native-closure';
import { hasCandidateImpact } from './analysis-admission';
import {
  jsonMembershipInputs,
  validateJsonInputMembership,
} from './json-input-membership';
import { retainNativeAnalysis } from './native-analysis-evidence';
import { outputSemanticProject } from './output-projection-context';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { SourceProject } from './types';
import { collectVueOutputDependencies } from './vue-output-projection';
// Independent of config-type-directives receipts: covers output governance.
export interface OutputProjectionReceipt {
  scope: 'existing-output-relations';
  version: 3;
  sourceConfig: string;
  generatedConfig: string;
  sourceTarget: number | null;
  outputTarget: number | null;
  contextId: string | null;
  vueContextId?: string;
  optionsVersion: string;
  roots: string[];
  covered: { file: string; owner: string; outputConfig: string }[];
}
interface ProjectionInput {
  project: SourceProject;
  state: GeneratedGraphPreparationState;
  cache?: NativeAnalysisCache;
  metrics?: AnalysisMetricsRecorder;
}
function dependencies(
  context: TypeScriptSemanticDependencyContext,
  project: TypeScriptSemanticProject,
): Map<string, string> {
  const snapshot = context.nativeEvidence;
  if (snapshot === undefined)
    throw new Error(
      `Output compilation evidence is unavailable: ${project.configPath}`,
    );
  for (const context of snapshot.contexts)
    if (context.inputs.config === project.configPath)
      validateJsonInputMembership(
        jsonMembershipInputs(snapshot, context.id).values(),
        project.fileNames,
        project.configPath,
      );
  for (const obligation of snapshot.obligations) {
    if (
      obligation.consumerConfigId === project.configPath &&
      summarizeCompilationObligation(obligation) === 'unknown' &&
      obligation.structure.state !== 'satisfied' &&
      hasCandidateImpact(snapshot, obligation)
    )
      throw new Error(
        `Unproved output compilation relation: ${project.configPath}: ${obligation.id}`,
      );
  }
  const projection = projectNativeDeclarationClosure(context, project);
  return new Map(
    projection.requirements.map(({ occurrence, requirement }) => [
      requirement.targetFileName,
      occurrence.filePath,
    ]),
  );
}
function baseReceipt(
  project: SourceProject,
  output: TypeScriptSemanticProject,
): OutputProjectionReceipt {
  return {
    scope: 'existing-output-relations',
    version: 3,
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
function coverDependencies(options: {
  project: SourceProject;
  owners: Map<string, SourceProject>;
  context: TypeScriptSemanticDependencyContext;
  output: TypeScriptSemanticProject;
}): OutputProjectionReceipt['covered'] {
  const { project, owners, context, output } = options;
  const targets = dependencies(context, output);
  return coverTargets(project, owners, targets);
}
function coverTargets(
  project: SourceProject,
  owners: Map<string, SourceProject>,
  targets: Map<string, string>,
): OutputProjectionReceipt['covered'] {
  const covered: OutputProjectionReceipt['covered'] = [];
  for (const [target, contributor] of targets) {
    const owner = foreignOwner(owners, target, project);
    if (owner !== undefined)
      covered.push(coveredTarget(project, owner, { target, contributor }));
  }
  return covered;
}
function vueReceipt(
  input: ProjectionInput,
  output: TypeScriptSemanticProject,
  owners: Map<string, SourceProject>,
): OutputProjectionReceipt {
  const projection = collectVueOutputDependencies({
    project: input.project,
    output,
    cache: input.cache,
    metrics: input.metrics,
  });
  return {
    ...baseReceipt(input.project, output),
    vueContextId: projection.contextId,
    covered: coverTargets(input.project, owners, projection.dependencies),
  };
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
    createTypeScriptDependencyContext(output, {
      analysisCache: input.cache,
      metrics: input.metrics,
    });
  try {
    retainNativeAnalysis(
      input.state.dependencyAnalysis,
      context.nativeEvidence,
    );
    return {
      ...baseReceipt(input.project, output),
      contextId: nativeContextId(output),
      covered: coverDependencies({
        project: input.project,
        owners,
        context,
        output,
      }),
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
  const output = outputSemanticProject(input.project, input.state, owners);
  if (input.project.semanticAuthority.family === 'vue')
    return vueReceipt(input, output, owners);
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
      receipt.version === 3,
    ].every(Boolean)
  )
    return false;
  return isValidProjectionContext(receipt, cache);
}
function isValidProjectionContext(
  receipt: OutputProjectionReceipt,
  cache: NativeAnalysisCache,
): boolean {
  if (receipt.vueContextId !== undefined)
    return isValidVueContext(receipt, cache, receipt.vueContextId);
  return receipt.contextId === null
    ? receipt.sourceTarget === receipt.outputTarget
    : isValidContext(receipt, cache, receipt.contextId);
}
function isValidVueContext(
  receipt: OutputProjectionReceipt,
  cache: NativeAnalysisCache,
  id: string,
): boolean {
  const identity = cache.vue.identity(id, 0);
  if (identity === undefined) return false;
  return [
    identity.configPath === receipt.generatedConfig,
    identity.outputSourceConfigPath === receipt.sourceConfig,
    analysisHash(identity.options) === receipt.optionsVersion,
    analysisHash(identity.fileNames) === analysisHash(receipt.roots),
  ].every(Boolean);
}
