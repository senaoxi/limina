import type { VueProjectSemanticIdentity } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { analysisHash } from './identity';
import { observeTypeEnvironment } from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import { retainData } from './snapshot-records';
import type { VueContextRecord, VueQueryRecord } from './vue-contracts';
import { VUE_ANALYSIS_ADAPTER, vueDataIdentity } from './vue-identity';
import { VueInputTrace } from './vue-inputs';
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
function outputProjection(
  identity: VueProjectSemanticIdentity,
): VueContextRecord['project']['outputProjection'] {
  return identity.outputSourceConfigPath === undefined
    ? undefined
    : {
        sourceConfigPath: identity.outputSourceConfigPath,
        options: effectiveCompilerOptions(identity.options),
        fileNames: [...identity.fileNames],
      };
}

export class VueRecordState {
  readonly trace: VueInputTrace;
  readonly queries: Record<string, VueQueryRecord>;
  readonly identity: VueProjectSemanticIdentity;
  readonly cache: NativeAnalysisCache;
  constructor(
    identity: VueProjectSemanticIdentity,
    cache: NativeAnalysisCache,
    previous?: VueContextRecord,
  ) {
    this.identity = identity;
    this.cache = cache;
    this.trace = new VueInputTrace(cache.inputs, identity);
    this.queries = { ...previous?.queries };
    if (previous !== undefined) this.#inherit(previous);
  }

  #inherit(previous: VueContextRecord): void {
    for (const dependency of previous.dependencies)
      this.trace.dependencies.set(dependency.inputId, dependency);
    for (const member of previous.members) this.trace.members.add(member);
    Object.assign(this.trace.generated, previous.generated);
  }

  capture(previous: VueContextRecord | undefined): VueContextRecord {
    observeVueTools(this.identity, this.trace);
    const members = [...this.trace.members].sort(compareCodeUnits);
    const environment = observeTypeEnvironment(
      vueEnvironmentProject(this.identity),
      this.cache.inputs,
      { members, tsModule: this.identity.toolchain.tsModule },
    );
    const dependencies = new Map(this.trace.dependencies);
    for (const dependency of environment.dependencies)
      dependencies.set(dependency.inputId, dependency);
    return retainData(previous, {
      adapter: VUE_ANALYSIS_ADAPTER,
      project: {
        configPath: this.identity.configPath,
        projectRootDir: this.identity.projectRootDir,
        extensions: [...this.identity.extensions],
        outputProjection: outputProjection(this.identity),
      },
      identity: vueDataIdentity(this.identity),
      dependencies: dependencies.values().toArray(),
      environment,
      members,
      generated: { ...this.trace.generated },
      queries: { ...this.queries },
      queryIds: Object.keys(this.queries).sort(compareCodeUnits),
      complete: this.trace.complete && environment.evidence !== 'unknown',
    });
  }
}

export function isCurrentVueRecord(
  cache: NativeAnalysisCache,
  identity: VueProjectSemanticIdentity,
  record: VueContextRecord,
): boolean {
  const valid = [
    record.complete,
    !cache.inputs.domainDirty,
    analysisHash(record.identity) === analysisHash(vueDataIdentity(identity)),
    record.dependencies.every((input) => cache.inputs.valid(input)),
  ];
  return (
    valid.every(Boolean) && isCurrentVueEnvironment(cache, identity, record)
  );
}
function isCurrentVueEnvironment(
  cache: NativeAnalysisCache,
  identity: VueProjectSemanticIdentity,
  record: VueContextRecord,
): boolean {
  const environment = observeTypeEnvironment(
    vueEnvironmentProject(identity),
    cache.inputs,
    { members: record.members, tsModule: identity.toolchain.tsModule },
  );
  if (
    analysisHash(environment.domains) !==
    analysisHash(record.environment.domains)
  )
    cache.inputs.invalidateDomain(identity.configPath);
  return (
    environment.evidence !== 'unknown' &&
    analysisHash(environment) === analysisHash(record.environment)
  );
}
