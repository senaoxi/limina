import { parseCheckerProjectConfigForContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { EpochInputs } from '../../core/analysis-cache/epoch-inputs';
import { frameworkExecutionInputs } from '../../core/analysis-cache/framework-execution-inputs';
import { vueExecutionInputs } from '../../core/analysis-cache/vue-execution-inputs';
import { readGraphRules } from '../../core/build-graph/generated/config-readers';
import { libraryProjectionFiles } from '../../core/build-graph/library-projection';
import type {
  GovernedSourceUnit,
  PreparedTsconfigGraph,
} from '../../core/build-graph/types';
import type { GovernedReference } from '../../graph-check/reference-governance';
import {
  collectLeafClassifications,
  collectTargetLeafConfigs,
} from '../managed/config';
import type { TypecheckTarget } from '../targets';

export interface ProjectKey {
  sourceConfigPath: string;
  checkerName: string;
}
interface MappedProject extends ProjectKey {
  isLeaf: boolean;
  role: ReferenceIdentity['kind'];
}
export interface ReferenceIdentity {
  from: ProjectKey;
  to: ProjectKey;
  fromConfigPath: string;
  toConfigPath: string;
  kind: 'declaration' | 'output' | 'solution-member' | 'wrapper' | 'check';
}
export interface ExecutionReferenceClosure {
  observations?: EpochInputs;
  projects?: ProjectKey[];
  configs: Set<string>;
  /** Physical configurations actually reached, including solution members
   * whose wrapper edges have no source-project identity. */
  executedConfigs: Set<string>;
  inputs: Set<string>;
  references: ReferenceIdentity[];
  governed: { reference: GovernedReference; aliases: Map<string, string[]> }[];
}
function addBuildIdentities(
  identities: Map<string, MappedProject>,
  builds: PreparedTsconfigGraph['sourceToBuild'],
  isLeaf: boolean,
): void {
  for (const [checkerName, sources] of builds)
    for (const [sourceConfigPath, module] of sources)
      identities.set(module.path, {
        sourceConfigPath,
        checkerName,
        isLeaf: isLeafBuild(isLeaf, module.kind),
        role: buildReferenceKind(isLeaf, module.kind),
      });
}
function projectIdentities(
  graph: PreparedTsconfigGraph,
): Map<string, MappedProject> {
  const identities = new Map<string, MappedProject>();
  addBuildIdentities(identities, graph.sourceToBuild, false);
  addBuildIdentities(identities, graph.configToOutputBuild, true);
  for (const [checkerName, sources] of graph.sourceToDts)
    for (const [sourceConfigPath, configPath] of sources)
      identities.set(configPath, {
        sourceConfigPath,
        checkerName,
        isLeaf: true,
        role: 'declaration',
      });
  return identities;
}
function frameworkSource(
  graph: PreparedTsconfigGraph,
  target: TypecheckTarget,
): GovernedSourceUnit {
  const sources = graph.governedSources
    .values()
    .flatMap((units) => units.values());
  const source = sources.find(
    (unit) =>
      unit.configPath === target.sourceConfigPath &&
      unit.frameworkCapabilities.some(
        (capability) => capability.family === target.checkerFamily,
      ),
  );
  if (source === undefined)
    throw new Error(
      'No source-consumption capability for the selected framework entry.',
    );
  return source;
}
function frameworkClosure(
  graph: PreparedTsconfigGraph,
  target: TypecheckTarget,
  config: ResolvedLiminaConfig,
): ExecutionReferenceClosure {
  const source = frameworkSource(graph, target);
  if (source.checkConfigPath !== undefined)
    return svelteCheckClosure(graph, source, config);
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    configPath: source.configPath,
    context: source.context,
    projectRootDir: config.rootDir,
  });
  // Framework source commands consume their own inputs. A schedule does not add a process.
  return {
    observations: frameworkExecutionInputs(source),
    projects: [
      {
        sourceConfigPath: source.configPath,
        checkerName: source.primaryCheckerName,
      },
    ],
    configs: new Set([source.configPath]),
    executedConfigs: new Set([source.configPath]),
    inputs: new Set([
      ...source.ownedFileNames,
      ...frameworkExecutionInputs(source).paths,
      ...parsed.configClosure.map((entry) => entry.filePath),
    ]),
    references: [],
    governed: [],
  };
}

function svelteCheckClosure(
  graph: PreparedTsconfigGraph,
  source: GovernedSourceUnit,
  config: ResolvedLiminaConfig,
): ExecutionReferenceClosure {
  const identities = projectIdentities(graph);
  const aliases = referenceAliases(graph);
  for (const units of graph.governedSources.values())
    for (const unit of units.values())
      if (unit.checkConfigPath !== undefined) {
        identities.set(unit.checkConfigPath, {
          sourceConfigPath: unit.configPath,
          checkerName: unit.primaryCheckerName,
          role: 'check',
          isLeaf: true,
        });
        appendAlias(aliases, unit.configPath, unit.checkConfigPath);
      }
  const result: ExecutionReferenceClosure = {
    observations: new EpochInputs(),
    projects: [],
    configs: new Set(),
    executedConfigs: new Set(),
    inputs: new Set(),
    references: [],
    governed: [],
  };
  const pending = [source.checkConfigPath!];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (result.executedConfigs.has(file)) continue;
    result.executedConfigs.add(file);
    result.inputs.add(file);
    const identity = identities.get(file);
    if (identity === undefined)
      throw new Error(`Unbound Svelte check reference: ${file}`);
    const unit = governedSource(graph, identity)!;
    result.projects!.push(identity);
    result.configs.add(unit.configPath);
    result.inputs.add(unit.configPath);
    for (const input of unit.ownedFileNames) result.inputs.add(input);
    if (unit.frameworkCapabilities.length > 0)
      result.observations!.append(frameworkExecutionInputs(unit));
    const configClosure =
      unit.context.vueSemanticIdentity?.configClosure ??
      parseCheckerProjectConfigForContext({
        allowNoInputDiagnostics: true,
        configPath: unit.configPath,
        context: unit.context,
        projectRootDir: config.rootDir,
      }).configClosure;
    for (const entry of configClosure) result.inputs.add(entry.filePath);
    const text = graph.generatedFiles.get(file);
    if (text === undefined)
      throw new Error(`Missing Svelte check execution config: ${file}`);
    const value = JSON.parse(text) as { references?: { path: string }[] };
    const references = value.references ?? [];
    for (const reference of references) {
      const to = normalizeAbsolutePath(
        path.resolve(path.dirname(file), reference.path),
      );
      const target = identities.get(to);
      if (target === undefined)
        throw new Error(`Unbound Svelte check reference: ${file} -> ${to}`);
      result.references.push({
        from: identity,
        to: target,
        fromConfigPath: file,
        toConfigPath: to,
        kind: identity.role,
      });
      result.governed.push({
        aliases,
        reference: {
          checkerName: identity.checkerName,
          from: file,
          to,
          labels: readGraphRules(config, unit.configPath),
        },
      });
      pending.push(to);
    }
  }
  for (const file of result.observations!.paths) result.inputs.add(file);
  const declarations = graph.producerBuildReceipt?.declarations ?? [];
  for (const output of declarations)
    if (result.configs.has(output.sourceConfig))
      result.inputs.add(output.outputFile);
  return result;
}
interface ClosureContext {
  graph: PreparedTsconfigGraph;
  config: ResolvedLiminaConfig;
  identities: Map<string, MappedProject>;
  aliases: Map<string, string[]>;
  result: ExecutionReferenceClosure;
}
export function collectExecutionReferenceClosure(
  graph: PreparedTsconfigGraph,
  target: TypecheckTarget,
  config: ResolvedLiminaConfig,
): ExecutionReferenceClosure {
  return target.checkerFamily === undefined
    ? nativeClosure({ graph, target, config })
    : frameworkClosure(graph, target, config);
}
function nativeClosure(options: {
  graph: PreparedTsconfigGraph;
  target: TypecheckTarget;
  config: ResolvedLiminaConfig;
}): ExecutionReferenceClosure {
  const physical = collectTargetLeafConfigs({
    classifications: collectLeafClassifications(options.graph),
    rootConfigPath: options.target.configPath,
  });
  const result: ExecutionReferenceClosure = {
    observations: new EpochInputs(),
    projects: [],
    configs: new Set(),
    executedConfigs: new Set([
      options.target.configPath,
      ...physical.configPaths,
    ]),
    inputs: new Set(physical.dependencies.map((item) => item.path)),
    references: [],
    governed: [],
  };
  const context = {
    ...options,
    identities: projectIdentities(options.graph),
    aliases: referenceAliases(options.graph),
    result,
  };
  for (const file of physical.configPaths) addConfigInputs(context, file);
  const receipts = options.graph.libraryProjections ?? [];
  for (const receipt of receipts)
    if (physical.configPaths.includes(receipt.generatedConfig))
      for (const file of libraryProjectionFiles(receipt).keys())
        result.inputs.add(file);
  for (const edge of physical.references) addReference(context, edge);
  return result;
}
function addConfigInputs(context: ClosureContext, file: string): void {
  const identity = context.identities.get(file);
  if (identity !== undefined) {
    addSourceInputs(context, identity);
    return;
  }
  if (!context.graph.generatedFiles.has(file))
    throw new Error(`Unmapped executed configuration: ${file}`);
}
function addSourceInputs(context: ClosureContext, identity: ProjectKey): void {
  const source = governedSource(context.graph, identity);
  context.result.projects!.push(identity);
  context.result.configs.add(identity.sourceConfigPath);
  context.result.inputs.add(identity.sourceConfigPath);
  if (source === undefined) return;
  for (const file of source.ownedFileNames) context.result.inputs.add(file);
  appendVueInputs(context, source);
}
function appendVueInputs(
  context: ClosureContext,
  source: GovernedSourceUnit,
): void {
  if (source.semanticAuthority.family === 'vue')
    context.result.observations!.append(
      vueExecutionInputs(source.context.vueSemanticIdentity),
    );
}
function declarationConfig(
  graph: PreparedTsconfigGraph,
  identity: ProjectKey,
): string {
  const config = graph.sourceToDts
    .get(identity.checkerName)
    ?.get(identity.sourceConfigPath);
  if (config === undefined)
    throw new Error(
      `Missing declaration mapping: ${identity.sourceConfigPath}`,
    );
  return config;
}
function addReference(
  context: ClosureContext,
  edge: { from: string; to: string },
): void {
  const from = context.identities.get(edge.from);
  const to = context.identities.get(edge.to);
  if (from === undefined || to === undefined) return;
  recordReference(context, { edge, from, to });
}
interface MappedReference {
  edge: { from: string; to: string };
  from: MappedProject;
  to: MappedProject;
}
function recordReference(
  context: ClosureContext,
  reference: MappedReference,
): void {
  const { from, to, edge } = reference;
  context.result.references.push({
    from,
    to,
    fromConfigPath: edge.from,
    toConfigPath: edge.to,
    kind: from.role,
  });
  if (![from.isLeaf, to.isLeaf].every(Boolean)) return;
  const fromDts = declarationConfig(context.graph, from);
  const toDts = declarationConfig(context.graph, to);
  context.result.governed.push({
    aliases: context.aliases,
    reference: {
      checkerName: from.checkerName,
      from: fromDts,
      to: toDts,
      labels: readGraphRules(context.config, from.sourceConfigPath),
    },
  });
}

function isLeafBuild(hasLeafProjection: boolean, kind: string): boolean {
  return hasLeafProjection && kind === 'project';
}

function governedSource(
  graph: PreparedTsconfigGraph,
  identity: ProjectKey,
): GovernedSourceUnit | undefined {
  return graph.governedSources
    .get(identity.checkerName)
    ?.get(identity.sourceConfigPath);
}

function buildReferenceKind(
  isLeaf: boolean,
  kind: string,
): ReferenceIdentity['kind'] {
  return isLeafBuild(isLeaf, kind) ? 'output' : containerReferenceKind(kind);
}
function containerReferenceKind(kind: string): ReferenceIdentity['kind'] {
  return kind === 'solution' ? 'solution-member' : 'wrapper';
}

function referenceAliases(graph: PreparedTsconfigGraph): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const projects of graph.sourceToDts.values())
    for (const [source, declaration] of projects)
      appendAlias(aliases, source, declaration);
  return aliases;
}

function appendAlias(
  aliases: Map<string, string[]>,
  source: string,
  declaration: string,
): void {
  aliases.set(source, [
    ...new Set([...(aliases.get(source) ?? []), declaration]),
  ]);
}
