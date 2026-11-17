import {
  type CheckerProjectConfigCache,
  isNativeTypeScriptProjectInput,
} from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import {
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  readJsonConfig,
} from '#core/tsconfig/actions';
import ts from 'typescript';
import {
  parseTypeScriptCommandLine,
  TypeScriptConfigInputError,
} from '../../checker/project-base';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { TsconfigInputError } from '../tsconfig/config-paths';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  nativeObservationFailureKind,
  observationErrorDetail,
} from '../typescript-semantic/native-observation-failure';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { AutoScopeProject } from './auto-checker-types';
import { SourceConfigDiscovery } from './source-config-discovery';

interface DiscoveredNativeProject {
  configPath: string;
  fileNames: string[];
  options: ts.CompilerOptions;
  projectReferences: readonly ts.ProjectReference[];
}

export interface NativeSourceUniverse {
  readonly coverage: SourceConfigCoverageIndex;
  readonly projects: readonly DiscoveredNativeProject[];
  readonly failures: readonly NativeEvidenceFailure[];
}

interface UniverseInput {
  discoveredProjects?: ReadonlyMap<string, AutoScopeProject>;
  config: ResolvedLiminaInputs;
  entries: readonly string[];
  activatedRegions: WorkspaceRegionPathIndex;
  projectConfigCache?: CheckerProjectConfigCache;
}

/**
Input discovery precedes ownership and governance. A bad selected config remains
in U; an independent selected config can still produce its Native baseline.
*/
export function discoverNativeSourceUniverse(
  input: UniverseInput,
): NativeSourceUniverse {
  const discovery = new SourceConfigDiscovery(
    input.entries.filter((config) => isSelectedConfig(input, config)),
    'native-source-universe-v1',
  );
  const state = {
    input,
    discovery,
    seen: new Set<string>(),
    projects: [] as DiscoveredNativeProject[],
    failures: [] as DiscoveryFailure[],
  };
  for (const config of input.entries) visitNativeConfig(state, config);
  if (state.failures.length === 0) discovery.close();
  const coverage = discovery.snapshot();
  return {
    coverage,
    projects: state.projects,
    failures: state.failures.map((failure) => ({
      id: nativeFingerprint(failure),
      kind: failure.kind,
      detail: failure.detail,
      evidenceIds: [failure.config],
      affected: { kind: 'universe', universeId: coverage.universe.id },
    })),
  };
}

interface DiscoveryState {
  input: UniverseInput;
  discovery: SourceConfigDiscovery;
  seen: Set<string>;
  projects: DiscoveredNativeProject[];
  failures: DiscoveryFailure[];
}

interface DiscoveryFailure {
  config: string;
  detail: string;
  kind: NativeEvidenceFailure['kind'];
}

function discoveryFailureKind(error: unknown): NativeEvidenceFailure['kind'] {
  return [TypeScriptConfigInputError, TsconfigInputError].some(
    (Type) => error instanceof Type,
  )
    ? 'config-parse'
    : nativeObservationFailureKind(error);
}

function isSelectedConfig(input: UniverseInput, config: string): boolean {
  return (
    input.activatedRegions.isSourceConfigPath(config) &&
    isOrdinarySourceTypecheckConfigPath(config, input.config.rootDir)
  );
}

function visitNativeConfig(state: DiscoveryState, config: string): void {
  if (shouldSkipNativeConfig(state, config)) return;
  state.seen.add(config);
  state.discovery.begin(config);
  try {
    collectNativeConfig(state, config);
  } catch (error) {
    state.failures.push({
      config,
      detail: observationErrorDetail(error),
      kind: discoveryFailureKind(error),
    });
  }
}

function collectNativeConfig(state: DiscoveryState, configPath: string): void {
  const configObject = readJsonConfig(state.input.config, configPath);
  const { parsed, configClosure } = parseTypeScriptCommandLine({
    parseOptions: {
      allowNoInputDiagnostics: true,
      configPath,
      projectRootDir: state.input.config.rootDir,
      virtualFiles: state.input.config.virtualFiles,
    },
  });
  const references = parsed.projectReferences ?? [];
  const isSolution = isLiminaSolutionConfig({
    configObject,
    configPath,
    fileNames: parsed.fileNames,
  });
  if (isSolution) {
    state.discovery.parsed(configPath, parsed.fileNames, {
      isSolution,
      basis: configClosure,
    });
    visitNativeReferences(state, references);
    return;
  }
  state.projects.push({
    configPath,
    fileNames: parsed.fileNames.filter(isNativeTypeScriptProjectInput),
    options: parsed.options,
    projectReferences: references,
  });
  // Selected-config membership also locates Framework candidates. It does not
  // add those files to the independent Native Program above or prove a request
  // obligation; that requires the current compiler observation.
  const project = state.input.discoveredProjects?.get(configPath);
  state.discovery.parsed(configPath, project?.fileNames ?? parsed.fileNames, {
    isSolution,
    basis: project?.configClosure ?? configClosure,
  });
}

function shouldSkipNativeConfig(
  state: DiscoveryState,
  config: string,
): boolean {
  return state.seen.has(config) || !isSelectedConfig(state.input, config);
}

function visitNativeReferences(
  state: DiscoveryState,
  references: readonly ts.ProjectReference[],
): void {
  for (const reference of references)
    visitNativeConfig(state, ts.resolveProjectReferencePath(reference));
}
