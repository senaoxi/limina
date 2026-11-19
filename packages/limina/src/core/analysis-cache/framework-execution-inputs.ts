import type { ResolvedLiminaInputs } from '#config/runner';
import {
  readAnalysisFileDigest,
  readAnalysisInput,
} from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type {
  GovernedSourceUnit,
  PreparedTsconfigGraph,
  SourceProject,
} from '../build-graph/types';
import type { ImportAnalysisContext } from '../import-analysis/types';
import type { ProjectDependencyCollection } from '../project-dependencies/contracts';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { observeNativeHostInputs } from '../typescript-semantic/native-host-inputs';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import type { DiscoveryRecord } from './contracts';
import { EpochInputs } from './epoch-inputs';
import {
  collectFrameworkConfigInputs,
  type FrameworkConfigLoads,
} from './framework-config-inputs';
import {
  type FrameworkTools,
  observeFrameworkTools,
  readFrameworkTools,
} from './framework-tools';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';

export interface FrameworkExecutionReceipt {
  observations: DiscoveryRecord[];
  toolchain: string;
}
const receipts = new WeakMap<GovernedSourceUnit, FrameworkExecutionReceipt>();
const rebound = new WeakSet<GovernedSourceUnit>();
interface QualifiedTools {
  tools: FrameworkTools;
  inputs?: EpochInputs;
}
const toolInputs = new WeakMap<
  EpochInputs,
  Map<string, QualifiedTools | undefined>
>();
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
  cache?: NativeAnalysisCache;
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
    withVirtualResolutionFiles(
      observedResolutionHost(
        ts,
        input.project.executionConfigPath ?? input.project.configPath,
      ),
      input.project.virtualFiles,
    ),
  );
}
function isFrameworkComponent(file: string): boolean {
  return /\.(?:svelte|astro)$/u.test(file);
}

function collectFrameworkImports(
  input: FrameworkInput,
  file: string,
  ownedFiles: ReadonlySet<string>,
): string[] {
  if (!input.project.virtualFiles?.has(file)) readContent(file);
  if (!isFrameworkComponent(file)) return [];
  if (
    input.cache !== undefined &&
    !input.project.virtualFiles?.has(file) &&
    ts.sys.fileExists(file)
  ) {
    const { inputs } = input.cache;
    if (ownedFiles.has(file))
      readAnalysisInput(file, () => inputs.sourceDigest(file), 'source-digest');
    else readAnalysisFileDigest(file);
  }
  const { source } = input;
  const preparation = input.analysis.prepareCheckerSemanticDependencies({
    filePath: file,
    context: {
      ...source.context,
      configPath: source.configPath,
      resolverConfigPath:
        input.project.executionConfigPath ?? source.configPath,
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
  const ownedFiles = new Set(input.source.ownedFileNames);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const targets = collectFrameworkImports(input, file, ownedFiles);
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
  const physicalHost = ts.createCompilerHost(input.project.options, true);
  observeNativeHostInputs(physicalHost);
  const host = withVirtualResolutionFiles(
    physicalHost,
    input.project.virtualFiles,
  );
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (...arguments_) => {
    const virtual = input.project.virtualFiles?.get(
      normalizeAbsolutePath(arguments_[0]),
    );
    return virtual === undefined
      ? original(...arguments_)
      : ts.createSourceFile(arguments_[0], virtual, arguments_[1], true);
  };
  // Input-only Program: no Native facts, project references or execution targets are produced.
  ts.createProgram({
    rootNames: [...roots].filter(
      (file) => !/\.(?:svelte|astro|vue)$/u.test(file),
    ),
    options: input.project.options,
    host,
  });
}
function frameworkCapability(source: GovernedSourceUnit) {
  const [capability] = source.frameworkCapabilities;
  const projectRoot =
    source.astroSemanticProject?.seed.packageRootDir ??
    source.svelteSemanticProject?.packageRootDir;
  return source.frameworkCapabilities.length === 1 &&
    capability?.packageRootDir === projectRoot &&
    capability?.family === source.semanticAuthority.family
    ? capability
    : undefined;
}

const missingContentVersion = analysisHash(undefined);

function receiptIdentity(
  source: GovernedSourceUnit,
  tools: FrameworkTools,
  observations: readonly DiscoveryRecord[],
): string | undefined {
  const keys = new Set(
    observations
      .filter(
        ({ key, path, descriptor }) =>
          'path' in descriptor &&
          descriptor.path === path &&
          key === JSON.stringify([descriptor.kind, path]),
      )
      .map(({ key }) => key),
  );
  if (
    tools.files.some(
      (file) => !keys.has(JSON.stringify(['file-digest', file])),
    ) ||
    tools.lookups.some((file) => !keys.has(JSON.stringify(['file', file])))
  )
    return undefined;
  const roots = new Set(
    observations
      .filter(
        (entry) =>
          entry.descriptor.kind === 'typescript-content' &&
          entry.version !== missingContentVersion,
      )
      .map((entry) => entry.path),
  );
  if (
    source.ownedFileNames.some(
      (file) =>
        !roots.has(file) ||
        (isFrameworkComponent(file) &&
          !keys.has(JSON.stringify(['source-digest', file]))),
    )
  )
    return undefined;
  const astro = source.astroSemanticProject?.readSnapshot();
  const svelte = source.svelteSemanticProject;
  const project = astro ?? svelte;
  if (project === undefined) return undefined;
  return nativeFingerprint([
    source.configPath,
    source.primaryCheckerName,
    source.semanticAuthority,
    source.frameworkCapabilities,
    source.ownedFileNames,
    source.packageRootDir,
    source.astroSemanticProject?.seed.projectFingerprint,
    astro?.checkerExtensions ?? svelte?.extensions,
    svelte?.adapterVersion,
    svelte?.packageIdentity,
    project.fileNames,
    project.configClosure,
    effectiveCompilerOptions(astro?.compilerOptions ?? svelte!.options),
    astro?.projectReferences ?? svelte?.references,
    svelte?.svelteOptions,
    svelte?.resolverConfigPath,
    svelte?.virtualFiles && [...svelte.virtualFiles],
    tools.identity,
    observations,
  ]);
}

function currentTools(
  source: GovernedSourceUnit,
  epoch: EpochInputs,
): QualifiedTools | undefined {
  const capability = frameworkCapability(source);
  if (capability === undefined) return undefined;
  const key = JSON.stringify([capability.family, capability.packageRootDir]);
  let entries = toolInputs.get(epoch);
  if (entries === undefined) {
    entries = new Map();
    toolInputs.set(epoch, entries);
  }
  if (!entries.has(key)) {
    const tools = readFrameworkTools(
      capability.family,
      capability.packageRootDir,
    );
    entries.set(key, tools && { tools });
  }
  const selected = entries.get(key);
  return selected?.tools.isCurrent() ? selected : undefined;
}

function collectToolInputs(input: FrameworkInput): QualifiedTools | undefined {
  if (input.cache === undefined) return undefined;
  const selected = currentTools(input.source, input.cache.epoch);
  if (selected === undefined || selected.inputs !== undefined) return selected;
  const inputs = new EpochInputs();
  try {
    inputs.run(() => observeFrameworkTools(selected.tools));
    selected.inputs = inputs;
    return selected;
  } catch {
    // The owning Checker retains responsibility for diagnosing its installation.
    return undefined;
  }
}

export function captureFrameworkExecutionReceipt(
  source: GovernedSourceUnit,
): FrameworkExecutionReceipt | undefined {
  return scopes.get(source) instanceof EpochInputs
    ? receipts.get(source)
    : undefined;
}

export function hasBoundFrameworkExecutionReceipt(
  source: GovernedSourceUnit,
  epoch: EpochInputs,
  receipt: FrameworkExecutionReceipt,
): boolean {
  const tools = currentTools(source, epoch)?.tools;
  if (
    !tools ||
    receiptIdentity(source, tools, receipt.observations) !== receipt.toolchain
  )
    return false;
  const qualified = epoch.selectRecords(receipt.observations);
  if (qualified === undefined) return false;
  scopes.set(source, qualified);
  receipts.set(source, receipt);
  rebound.add(source);
  return true;
}

export function hasFrameworkExecutionInputs(
  source: GovernedSourceUnit,
): boolean {
  return rebound.has(source);
}

/**
Source consumption has a transitive scope independent of the bounded compilation-obligation graph.
*/
export function collectFrameworkExecutionInputs<
  T extends ProjectDependencyCollection,
>(input: FrameworkInput, collect: () => T): T {
  if (input.source.frameworkCapabilities.length === 0) return collect();
  receipts.delete(input.source);
  rebound.delete(input.source);
  const inputs = new EpochInputs();
  const tools = collectToolInputs(input);
  let failure: Error | undefined;
  const collection = inputs.collect(() => {
    tools?.inputs?.publish();
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
  if (failure === undefined && tools?.tools.isCurrent()) {
    const observations = inputs.snapshot();
    if (observations !== undefined) {
      const toolchain = receiptIdentity(
        input.source,
        tools.tools,
        observations,
      );
      if (toolchain !== undefined)
        receipts.set(input.source, { observations, toolchain });
    }
  }
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
  const receipt = receipts.get(source);
  if (receipt !== undefined) receipts.set(published, receipt);
  if (rebound.has(source)) rebound.add(published);
}

export async function completeFrameworkExecutionInputs(
  graph: PreparedTsconfigGraph,
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
