import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
} from '../build-graph/types';
import { EpochInputs } from './epoch-inputs';
import type { NativeAnalysisCache } from './native-cache';

interface ContextReads {
  configPath: string;
  inputs: EpochInputs;
}
const contexts = new WeakMap<NativeEvidenceSnapshot, ContextReads>();
const graphs = new WeakMap<GeneratedTsconfigGraphResult, EpochInputs>();

export function retainContextExecutionInputs(
  snapshot: NativeEvidenceSnapshot | undefined,
  configPath: string,
  inputs: EpochInputs,
): void {
  if (snapshot !== undefined) contexts.set(snapshot, { configPath, inputs });
}
export function retainGraphExecutionInputs(
  graph: GeneratedTsconfigGraphResult,
  inputs: EpochInputs,
): void {
  if (!graphs.has(graph)) graphs.set(graph, inputs);
}

export interface ExecutionInputScope {
  readonly paths: ReadonlySet<string>;
  affectedOutputs(outputs: ReadonlySet<string>): ReadonlySet<string>;
  assertStable(except?: ReadonlySet<string>): Promise<void>;
}

/**
Select existing observations; never read a new baseline to bless stale evidence.
*/
export function graphExecutionInputScope(
  graph: GeneratedTsconfigGraphResult,
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
    assertStable: (except) => validateSelected(selected, except),
  };
}
function requireGraphInputs(
  graph: GeneratedTsconfigGraphResult,
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
  for (const config of configs)
    if (!inputs.paths.has(config))
      throw new Error(`Unobserved execution config: ${config}`);
}
function selectedContextInputs(
  graph: GeneratedTsconfigGraphResult,
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
): Promise<void> {
  for (const input of inputs) await input.assertStable(except);
}
export async function bindRestoredGraphExecutionInputs(
  graph: GeneratedTsconfigGraphResult,
  cache: NativeAnalysisCache,
): Promise<void> {
  retainGraphExecutionInputs(graph, cache.epoch);
  const evidence = nativeEntries(graph).filter((entry) =>
    hasLockedContext(entry.snapshot),
  );
  for (const entry of evidence) await bindContextInputs(entry.snapshot, cache);
}
async function bindContextInputs(
  snapshot: NonNullable<
    DependencyAnalysisResult['nativeEvidence']
  >[number]['snapshot'],
  cache: NativeAnalysisCache,
): Promise<void> {
  const record = Object.values(cache.contexts).find(
    (item) => contextIdentity(item) === snapshot.contexts[0]?.id,
  );
  const native = requireNativeRecord(record);
  const inputs = new EpochInputs();
  if (!(await inputs.validate(native.discovery)))
    throw new Error('Execution context inputs changed during restore.');
  retainContextExecutionInputs(snapshot, record!.project.configPath, inputs);
}
function contextIdentity(
  record: NativeAnalysisCache['contexts'][string],
): string | undefined {
  return record.native?.snapshot.contexts[0]?.id;
}

function nativeEntries(graph: GeneratedTsconfigGraphResult) {
  return graph.dependencyAnalysis?.nativeEvidence ?? [];
}

function requireNativeRecord(
  record: NativeAnalysisCache['contexts'][string] | undefined,
) {
  const native = record?.native;
  if (native === undefined)
    throw new Error('Missing validated context inputs.');
  return native;
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
