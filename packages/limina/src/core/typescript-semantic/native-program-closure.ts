import type ts from 'typescript';
import {
  type AnalysisObserver,
  currentProfile,
} from '../../application/analysis/observability';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { observeWork, profileContextScope } from '../analysis-profile';
import { measureBoundedProgram } from './metrics';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import { initializeNativeCompiler } from './native-observation-failure';
import {
  nativeObservedProgram,
  type NativeObservedProgram,
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import { createNativeProgramHost } from './native-program-host';
import { collectNativeProgramInventory } from './native-program-inventory';
import { NativeProgramLoads } from './native-program-loads';
import {
  type NativeModuleObservation,
  NativeProgramRequests,
} from './native-program-requests';
import { assertNativeObservationInputs } from './native-program-validity';
export function createBoundedProgramClosure(
  options: NativeProgramObservationOptions & {
    observationRootNames: readonly string[];
  },
  compiler: typeof ts,
  frontier: NativeProgramFrontier,
): {
  program: NativeObservedProgram;
  modules: readonly NativeModuleObservation[];
  requests: NativeProgramRequests;
  loads: NativeProgramLoads;
  configReads: string[];
  failures: NativeEvidenceFailure[];
} {
  const { project, context, observationRootNames } = options;
  const observer = currentProfile();
  observer?.runtime({ typescript: compiler.version });
  const scope =
    observer === undefined
      ? undefined
      : nativeProgramProfileScope(observer, options);
  let pass = 0;
  const configReads: string[] = [];
  const failures: NativeEvidenceFailure[] = [];
  const loads = new NativeProgramLoads({
    project,
    observationRootNames,
    compiler,
    frontier,
    failures: { contextId: context.id, failures },
  });
  let requests: NativeProgramRequests;
  let program: NativeObservedProgram;
  let modules: readonly NativeModuleObservation[];
  let isRepeat: boolean;
  do {
    const revision = loads.revision;
    requests = new NativeProgramRequests(context, frontier.identities);
    loads.paths.clear();
    const host = createNativeProgramHost({
      project,
      compiler,
      queries: options.queries,
      frontier,
      loads,
      configReads,
      requests,
      contextId: context.id,
      failures,
    });
    const create = () =>
      initializeNativeCompiler(() =>
        compiler.createProgram({
          rootNames: [...observationRootNames],
          options: project.options,
          projectReferences: project.projectReferences,
          host,
        }),
      );
    const passNumber = observer === undefined ? undefined : ++pass;
    const rawProgram = measureBoundedProgram(
      observer === undefined
        ? create
        : () =>
            observeWork(
              observer,
              'native-program-create',
              create,
              scope,
              passNumber,
              'computed',
            ),
      options.metrics,
    );
    if (observer !== undefined && scope !== undefined) {
      observer.metric(
        'program-roots',
        scope,
        'items',
        rawProgram.getRootFileNames().length,
      );
      observer.metric(
        'program-source-files',
        scope,
        'items',
        rawProgram.getSourceFiles().length,
      );
    }
    program = nativeObservedProgram(
      rawProgram,
      compiler,
      requests.optionsBySource,
    );
    modules = collectNativeProgramInventory({
      program,
      compiler,
      requests,
      frontier,
    });
    // A newly discovered import can change physical loading. Register it in
    // the same convergence protocol as resolver callbacks, before freezing.
    registerInventoryLoads(loads, modules, program);
    // TS 6 can use built-in libraries without invoking resolveLibrary. These
    // are actual Compiler inventory targets, not filesystem pre-scan grants.
    for (const { request, resolution } of requests.entries)
      if (request.channel === 'library')
        loads.grant(resolution.target?.lexicalPath);
    isRepeat = loads.finishPass(program, revision);
    assertNativeObservationInputs(options, compiler);
  } while (isRepeat);
  loads.observeTargets(
    program,
    requests.entries.flatMap(({ resolution }) =>
      resolution.target === null ? [] : [resolution.target.lexicalPath],
    ),
  );
  return { program, modules, requests, loads, configReads, failures };
}

function nativeProgramProfileScope(
  observer: AnalysisObserver,
  { project, context, profileRole }: NativeProgramObservationOptions,
) {
  const declaration = project.declarationContextValidation;
  return profileContextScope(observer, {
    instance: context,
    configPath:
      declaration?.sourceConfig ??
      project.sourceConfigPath ??
      project.configPath,
    checker: project.analysisBinding?.checker.replace(/:output$/u, '') ?? 'tsc',
    provider: 'typescript',
    role:
      declaration === undefined
        ? (profileRole ??
          (project.analysisBinding?.checker.endsWith(':output')
            ? 'output-projection'
            : (project.analysisBinding?.phase ?? 'dependency')))
        : 'declaration-candidate',
  });
}

function registerInventoryLoads(
  loads: NativeProgramLoads,
  modules: readonly NativeModuleObservation[],
  program: NativeObservedProgram,
): void {
  for (const observation of modules)
    registerInventoryLoad(loads, observation, program);
}
function registerInventoryLoad(
  loads: NativeProgramLoads,
  observation: NativeModuleObservation,
  program: NativeObservedProgram,
): void {
  const options = program.getCompilerOptionsForFile(observation.source);
  if (
    options !== undefined &&
    observation.role === 'import' &&
    !options.noResolve
  )
    loads.resolved(moduleTarget(observation));
}
function moduleTarget(
  observation: NativeModuleObservation,
): string | undefined {
  return observation.raw?.resolvedModule?.resolvedFileName;
}
