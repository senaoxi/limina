import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type {
  DependencyAnalysisResult,
  PreparedTsconfigGraph,
} from '../build-graph/types';
import type { EpochInputs } from './epoch-inputs';
import { EpochInputReplay } from './epoch-inputs';
import type { NativeAnalysisCache } from './native-cache';
import { bindResolutionExecutionInputs } from './resolution-execution-inputs';

interface ContextReads {
  configPath: string;
  inputs: EpochInputs;
}
const contexts = new WeakMap<NativeEvidenceSnapshot, ContextReads>();
const graphs = new WeakMap<PreparedTsconfigGraph, EpochInputs>();
type DeclarationValidation = NonNullable<
  DependencyAnalysisResult['declarationValidation']
>;
const declarationCandidates = new WeakMap<
  DeclarationValidation,
  Map<string, EpochInputs>
>();

export function retainDeclarationCandidateExecutionInputs(
  validation: DeclarationValidation,
  generatedConfig: string,
  inputs: EpochInputs,
): void {
  const candidates = declarationCandidates.get(validation) ?? new Map();
  candidates.set(generatedConfig, inputs);
  declarationCandidates.set(validation, candidates);
}

export function declarationCandidateExecutionInputs(
  graph: Pick<PreparedTsconfigGraph, 'dependencyAnalysis'>,
  generatedConfig: string,
): EpochInputs | undefined {
  const validation = graph.dependencyAnalysis?.declarationValidation;
  return validation === undefined
    ? undefined
    : declarationCandidates.get(validation)?.get(generatedConfig);
}

export function retainContextExecutionInputs(
  snapshot: NativeEvidenceSnapshot | undefined,
  configPath: string,
  inputs: EpochInputs,
  queries?: { cache: NativeAnalysisCache; ids: Iterable<string> },
): void {
  if (snapshot === undefined) return;
  if (queries !== undefined)
    bindResolutionExecutionInputs(inputs, queries.cache, queries.ids);
  contexts.set(snapshot, { configPath, inputs });
}
export function retainGraphExecutionInputs(
  graph: PreparedTsconfigGraph,
  inputs: EpochInputs,
): void {
  if (!graphs.has(graph)) graphs.set(graph, inputs);
}

export interface ExecutionInputScope {
  readonly paths: ReadonlySet<string>;
  affectedOutputs(outputs: ReadonlySet<string>): ReadonlySet<string>;
  assertStable(
    except?: ReadonlySet<string>,
    replay?: EpochInputReplay,
  ): Promise<void>;
}

export async function isExecutionScopeStable(
  scope: ExecutionInputScope,
  replay: EpochInputReplay,
): Promise<boolean> {
  try {
    await scope.assertStable(undefined, replay);
    return true;
  } catch {
    return false;
  }
}

/**
Select existing observations; never read a new baseline to bless stale evidence.
*/
export function graphExecutionInputScope(
  graph: PreparedTsconfigGraph,
  configs: ReadonlySet<string>,
  selection:
    | ReadonlySet<string>
    | { paths: ReadonlySet<string>; observations?: EpochInputs },
): ExecutionInputScope {
  const { paths, observations } =
    'paths' in selection
      ? selection
      : { paths: selection, observations: undefined };
  const inputs = requireGraphInputs(graph, configs);
  const selected = [
    inputs.select(paths),
    ...selectedContextInputs(graph, configs),
    ...(observations === undefined ? [] : [observations]),
  ];
  const allPaths = new Set(selected.flatMap((input) => [...input.paths]));
  return {
    paths: allPaths,
    affectedOutputs: (outputs) =>
      new Set(selected.flatMap((input) => [...input.affectedOutputs(outputs)])),
    assertStable: (except, replay) =>
      validateSelected(selected, except, replay),
  };
}
function requireGraphInputs(
  graph: PreparedTsconfigGraph,
  configs: ReadonlySet<string>,
): EpochInputs {
  const inputs = graphs.get(graph);
  if (inputs === undefined)
    throw new Error('Execution input observations are unavailable.');
  assertObservedConfigs(inputs, configs);
  return inputs;
}
function assertObservedConfigs(
  inputs: EpochInputs,
  configs: ReadonlySet<string>,
): void {
  const paths = inputs.paths;
  for (const config of configs)
    if (!paths.has(config))
      throw new Error(`Unobserved execution config: ${config}`);
}
function selectedContextInputs(
  graph: PreparedTsconfigGraph,
  configs: ReadonlySet<string>,
): EpochInputs[] {
  const evidence = nativeEntries(graph).filter((entry) =>
    hasLockedContext(entry.snapshot),
  );
  return evidence.flatMap((entry) => selectedContext(entry.snapshot, configs));
}
function selectedContext(
  snapshot: NativeEvidenceSnapshot,
  configs: ReadonlySet<string>,
): EpochInputs[] {
  const context = contexts.get(snapshot);
  if (context === undefined) return requireUnrelatedSnapshot(snapshot, configs);
  return configs.has(context.configPath) ? [context.inputs] : [];
}
async function validateSelected(
  inputs: readonly EpochInputs[],
  except?: ReadonlySet<string>,
  replay = new EpochInputReplay(),
): Promise<void> {
  for (const input of inputs) await input.assertStable(except, replay);
}
export function hasBoundRestoredGraphExecutionInputs(
  graph: PreparedTsconfigGraph,
  cache: NativeAnalysisCache,
): boolean {
  const contexts = new Map(
    Object.values(cache.contexts).map((record) => [
      contextIdentity(record),
      record,
    ]),
  );
  for (const { snapshot } of nativeEntries(graph)) {
    if (!hasLockedContext(snapshot)) continue;
    const record = contexts.get(snapshot.contexts[0]?.id);
    if (record?.native === undefined) return false;
    const inputs = cache.epoch.selectRecords(record.native.discovery);
    if (inputs === undefined) return false;
    retainContextExecutionInputs(snapshot, record.project.configPath, inputs, {
      cache,
      ids: record.queryIds,
    });
  }
  retainGraphExecutionInputs(graph, cache.epoch);
  return true;
}
function contextIdentity(
  record: NativeAnalysisCache['contexts'][string],
): string | undefined {
  return record.native?.snapshot.contexts[0]?.id;
}

function nativeEntries(graph: PreparedTsconfigGraph) {
  return graph.dependencyAnalysis?.nativeEvidence ?? [];
}

function requireUnrelatedSnapshot(
  snapshot: NativeEvidenceSnapshot,
  configs: ReadonlySet<string>,
): EpochInputs[] {
  if (snapshot.obligations.some((item) => configs.has(item.consumerConfigId)))
    throw new Error(
      'Necessary Native context input observations are unavailable.',
    );
  return [];
}

function hasLockedContext(snapshot: NativeEvidenceSnapshot): boolean {
  return snapshot.contexts.some(
    (context) => context.authority.phase === 'locked',
  );
}
