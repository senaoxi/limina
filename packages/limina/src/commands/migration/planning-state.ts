import type { ResolvedLiminaConfig } from '#config/runner';
import type { JsonObject } from '#core/tsconfig/actions';
import type { MigrationRecord } from './declarations';
import type { MigrationTarget } from './types';

export interface MigrationPlanningState {
  config: ResolvedLiminaConfig;
  candidateConfig: ResolvedLiminaConfig;
  paths: string[];
  snapshot: Map<string, string>;
  targets: Map<string, MigrationTarget>;
  objects: Map<string, JsonObject>;
  isolated: Map<string, string>;
  blockedTargets: Set<string>;
  records: MigrationRecord[];
  incomplete: boolean;
}

export function createPlanningState(
  config: ResolvedLiminaConfig,
  paths: string[],
): MigrationPlanningState {
  return {
    config,
    candidateConfig: config,
    paths,
    snapshot: new Map(),
    targets: new Map(),
    objects: new Map(),
    isolated: new Map(),
    blockedTargets: new Set(),
    records: [],
    incomplete: false,
  };
}

export function planningView(
  state: MigrationPlanningState,
): ResolvedLiminaConfig {
  const virtualFiles = new Map(state.snapshot);
  for (const [file, object] of state.objects)
    virtualFiles.set(file, JSON.stringify(object));
  return { ...state.candidateConfig, virtualFiles };
}
