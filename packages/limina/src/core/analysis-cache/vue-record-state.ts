import type { VueProjectSemanticIdentity } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { encodeData } from './data-codec';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { createQueryDataPool } from './record-table';
import { retainData } from './snapshot-records';
import { observeTypeEnvironment } from './type-environment';
import type { VueContextRecord, VueQueryRecord } from './vue-contracts';
import { bindVueExecutionInputs } from './vue-execution-inputs';
import {
  VUE_ANALYSIS_ADAPTER,
  vueDataIdentity,
  vueModuleContextId,
} from './vue-identity';
import { VueInputTrace } from './vue-inputs';
import { VueModuleReplay } from './vue-module-replay';
import { observeVueTools } from './vue-toolchain-inputs';

function vueEnvironmentProject(
  identity: VueProjectSemanticIdentity,
): TypeScriptSemanticProject {
  return {
    configPath: identity.configPath,
    fileNames: identity.fileNames,
    options: identity.options,
    projectReferences: identity.projectReferences,
    workspaceSourceBoundary: { identity: '', has: () => true },
  };
}
export class VueRecordState {
  #queryData?: ReturnType<typeof createQueryDataPool>;
  readonly trace: VueInputTrace;
  readonly queries: Record<string, VueQueryRecord>;
  readonly identity: VueProjectSemanticIdentity;
  readonly cache: NativeAnalysisCache;
  constructor(
    identity: VueProjectSemanticIdentity,
    cache: NativeAnalysisCache,
    previous?: VueContextRecord,
    reusableModules?: VueContextRecord,
  ) {
    this.identity = identity;
    this.cache = cache;
    this.trace = new VueInputTrace(cache.inputs, identity);
    this.trace.moduleReplay = new VueModuleReplay({
      cache,
      identity,
      trace: this.trace,
      previous: previous ?? reusableModules,
      restored: previous !== undefined,
    });
    this.queries = { ...previous?.queries };
    if (previous !== undefined) this.#inherit(previous);
    bindVueExecutionInputs(
      identity,
      cache.inputs,
      this.trace.dependencies.values(),
    );
  }

  #inherit(previous: VueContextRecord): void {
    for (const dependency of previous.dependencies)
      this.trace.dependencies.set(dependency.inputId, dependency);
    for (const member of previous.members) this.trace.members.add(member);
    Object.assign(this.trace.generated, previous.generated);
  }

  captureQuery(
    key: string,
    kind: VueQueryRecord['kind'],
    result: unknown,
  ): void {
    this.#queryData ??= createQueryDataPool();
    this.queries[key] = { kind, data: this.#queryData(encodeData(result)) };
  }

  capture(previous: VueContextRecord | undefined): VueContextRecord {
    this.#queryData = undefined;
    observeVueTools(this.identity, this.trace);
    const members = [...this.trace.members].sort(compareCodeUnits);
    const environment = observeTypeEnvironment(
      vueEnvironmentProject(this.identity),
      this.cache.inputs,
      { tsModule: this.identity.toolchain.tsModule },
    );
    const dependencies = new Map(this.trace.dependencies);
    for (const dependency of environment.dependencies)
      dependencies.set(dependency.inputId, dependency);
    return retainData(previous, {
      adapter: VUE_ANALYSIS_ADAPTER,
      project: {
        configPath: this.identity.configPath,
        sourceConfigPath: this.identity.outputProjection?.sourceConfigPath,
      },
      identity: vueDataIdentity(this.identity),
      dependencies: dependencies.values().toArray(),
      environment,
      members,
      generated: { ...this.trace.generated },
      queries: { ...this.queries },
      queryIds: Object.keys(this.queries).sort(compareCodeUnits),
      moduleResolutions: this.trace.moduleReplay?.records ?? {},
      moduleContextId: vueModuleContextId(this.identity),
      complete: this.trace.complete && environment.evidence !== 'unknown',
    });
  }
}

export function vueRecordRejection(
  cache: NativeAnalysisCache,
  identity: VueProjectSemanticIdentity,
  record: VueContextRecord,
): string | undefined {
  const checks = [
    ['vue-context-incomplete', record.complete],
    ['toolchain-input-changed', !cache.inputs.toolchainChanged],
    [
      'vue-config-closure-changed',
      cache.inputs.configCurrent(
        identity.configClosure.map(({ filePath }) => filePath),
      ),
    ],
    [
      'vue-context-identity-changed',
      analysisHash(record.identity) === analysisHash(vueDataIdentity(identity)),
    ],
    [
      'vue-context-input-stale',
      record.dependencies.every((input) => cache.inputs.valid(input)),
    ],
  ] as const;
  const rejection = checks.find(([, valid]) => !valid)?.[0];
  if (rejection !== undefined) return rejection;
  return isCurrentVueEnvironment(cache, identity, record)
    ? undefined
    : 'vue-environment-unqualified';
}
function isCurrentVueEnvironment(
  cache: NativeAnalysisCache,
  identity: VueProjectSemanticIdentity,
  record: VueContextRecord,
): boolean {
  const environment = observeTypeEnvironment(
    vueEnvironmentProject(identity),
    cache.inputs,
    { tsModule: identity.toolchain.tsModule },
  );
  // Environment dependencies invalidate this Vue context and its owned queries.
  // Another independently qualified installation keeps its own authority.
  return (
    environment.evidence !== 'unknown' &&
    analysisHash(environment) === analysisHash(record.environment)
  );
}
