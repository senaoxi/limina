import type ts from 'typescript';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { measureBoundedProgram } from './metrics';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import { initializeNativeCompiler } from './native-observation-failure';
import type { NativeProgramFrontier } from './native-program-frontier';
import { createNativeProgramHost } from './native-program-host';
import { NativeProgramLoads } from './native-program-loads';
import { NativeProgramRequests } from './native-program-requests';
import { assertNativeObservationInputs } from './native-program-validity';
export function createBoundedProgramClosure(
  options: NativeProgramObservationOptions,
  compiler: typeof ts,
  frontier: NativeProgramFrontier,
): {
  program: ts.Program;
  requests: NativeProgramRequests;
  loads: NativeProgramLoads;
  configReads: string[];
  failures: NativeEvidenceFailure[];
} {
  const { project, context } = options;
  const loads = new NativeProgramLoads(project, compiler, frontier);
  const configReads: string[] = [];
  const failures: NativeEvidenceFailure[] = [];
  let requests: NativeProgramRequests;
  let program: ts.Program;
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
    program = measureBoundedProgram(
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
    isRepeat = loads.finishPass(program, revision);
    assertNativeObservationInputs(options, compiler);
  } while (isRepeat);
  return { program, requests, loads, configReads, failures };
}
