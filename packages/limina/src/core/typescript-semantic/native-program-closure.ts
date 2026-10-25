import type ts from 'typescript';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
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
  options: NativeProgramObservationOptions,
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
  const { project, context } = options;
  const configReads: string[] = [];
  const failures: NativeEvidenceFailure[] = [];
  const loads = new NativeProgramLoads({
    project,
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
      frontier,
      loads,
      configReads,
      requests,
      contextId: context.id,
      failures,
    });
    const rawProgram = measureBoundedProgram(
      () =>
        initializeNativeCompiler(() =>
          compiler.createProgram({
            rootNames: [...project.fileNames],
            options: project.options,
            projectReferences: project.projectReferences,
            host,
          }),
        ),
      options.metrics,
    );
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
