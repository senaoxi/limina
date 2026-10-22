import type { ResolvedLiminaInputs } from '#config/runner';
import { readAnalysisInput } from '#utils/analysis-input';
import ts from 'typescript';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
  SourceProject,
} from '../build-graph/types';
import type { ImportAnalysisContext } from '../import-analysis/types';
import type { ProjectDependencyCollection } from '../project-dependencies/contracts';
import { observeNativeHostInputs } from '../typescript-semantic/native-host-inputs';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { EpochInputs } from './epoch-inputs';
import {
  collectFrameworkConfigInputs,
  type FrameworkConfigLoads,
} from './framework-config-inputs';

const scopes = new WeakMap<GovernedSourceUnit, EpochInputs | Error>();
// Managed refresh keeps the original configuration proof within this invocation.
// Reloading CommonJS would reuse its module cache rather than establish fresh evidence.
const configLoads = new WeakMap<ResolvedLiminaInputs, FrameworkConfigLoads>();
function frameworkConfigLoads(
  config: ResolvedLiminaInputs,
): FrameworkConfigLoads {
  const loads = configLoads.get(config) ?? new Map();
  configLoads.set(config, loads);
  return loads;
}
interface FrameworkInput {
  source: GovernedSourceUnit;
  project: SourceProject;
  analysis: ImportAnalysisContext;
}
function readContent(file: string): void {
  readAnalysisInput(file, () => ts.sys.readFile(file), 'typescript-content');
}
function resolveRecord(
  input: FrameworkInput,
  record: { specifier: string; filePath: string },
): void {
  ts.resolveModuleName(
    record.specifier,
    record.filePath,
    input.project.options,
    observedResolutionHost(ts, input.project.configPath),
  );
}
function collectFrameworkImports(
  input: FrameworkInput,
  file: string,
): string[] {
  readContent(file);
  if (!/\.(?:svelte|astro)$/u.test(file)) return [];
  const { source } = input;
  const preparation = input.analysis.prepareCheckerSemanticDependencies({
    filePath: file,
    context: {
      ...source.context,
      configPath: source.configPath,
      resolverConfigPath: source.configPath,
      semanticFamily: source.semanticAuthority.family,
      svelteSemanticProject: source.svelteSemanticProject,
      astroSemanticProject: source.astroSemanticProject,
    },
  });
  if (preparation.kind === 'unsupported') throw new Error(preparation.reason);
  return preparation.facts.flatMap((fact) => {
    resolveRecord(input, fact.importRecord);
    return fact.target === null ? [] : [fact.target.resolvedFileName];
  });
}
function collectFrameworkClosure(
  input: FrameworkInput,
  roots: Set<string>,
): void {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const targets = collectFrameworkImports(input, file);
    addRoots(roots, targets);
    pending.push(...targets);
  }
}
function collectConsumption(
  input: FrameworkInput,
  result: ProjectDependencyCollection,
): void {
  const roots = new Set([
    ...input.project.fileNames,
    ...result.dependencies.map((dependency) => dependency.resolvedFilePath),
  ]);
  for (const entry of [...result.dependencies, ...result.observations])
    if ('importRecord' in entry) resolveRecord(input, entry.importRecord);
  collectFrameworkClosure(input, roots);
  const host = ts.createCompilerHost(input.project.options, true);
  observeNativeHostInputs(host);
  // Input-only Program: no Native facts, project references or execution targets are produced.
  ts.createProgram({
    rootNames: [...roots].filter(
      (file) => !/\.(?:svelte|astro|vue)$/u.test(file),
    ),
    options: input.project.options,
    host,
  });
}
/**
Source consumption has a transitive scope independent of the bounded compilation-obligation graph.
*/
export function collectFrameworkExecutionInputs<
  T extends ProjectDependencyCollection,
>(input: FrameworkInput, collect: () => T): T {
  if (input.source.frameworkCapabilities.length === 0) return collect();
  const inputs = new EpochInputs();
  let failure: Error | undefined;
  const collection = inputs.collect(() => {
    for (const file of input.project.fileNames) readContent(file);
    const result = collect();
    try {
      collectConsumption(input, result);
    } catch (error) {
      failure = asError(error);
    }
    return result;
  });
  scopes.set(input.source, failure ?? inputs);
  return collection;
}
export function frameworkExecutionInputs(
  source: GovernedSourceUnit,
): EpochInputs {
  const inputs = scopes.get(source);
  if (inputs instanceof Error) throw inputs;
  if (inputs === undefined)
    throw new Error('Framework consumption observations are unavailable.');
  return inputs;
}
/**
Keep input provenance when Core publishes a defensive source copy.
*/
export function retainFrameworkExecutionInputs(
  source: GovernedSourceUnit,
  published: GovernedSourceUnit,
): void {
  const observations = scopes.get(source);
  if (observations !== undefined) scopes.set(published, observations);
}

export async function completeFrameworkExecutionInputs(
  graph: GeneratedTsconfigGraphResult,
  config: ResolvedLiminaInputs,
): Promise<void> {
  const loads = frameworkConfigLoads(config);
  const sources = graph.governedSources
    .values()
    .flatMap((units) => units.values());
  for (const source of sources) {
    const inputs = scopes.get(source);
    if (inputs instanceof EpochInputs)
      await completeSourceInputs({ source, inputs, loads });
  }
}
async function completeSourceInputs(
  input: Parameters<typeof collectFrameworkConfigInputs>[0],
): Promise<void> {
  try {
    await collectFrameworkConfigInputs(input);
  } catch (error) {
    scopes.set(input.source, asError(error));
  }
}

function addRoots(roots: Set<string>, targets: string[]): void {
  for (const target of targets) roots.add(target);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
