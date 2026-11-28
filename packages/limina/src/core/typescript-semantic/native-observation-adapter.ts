import ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { BoundedResolutionQueries } from './bounded-resolution-queries';
import { compilerPathPolicy } from './compiler-path-key';
import type { TypeScriptSemanticProject } from './contracts';
import { collectNativeObligations } from './native-obligation-inventory';
import { NativeObservationError } from './native-observation-failure';
import { assertNativeProgramCompiler } from './native-program-api';
import { createBoundedProgramClosure } from './native-program-closure';
import { NativeProgramFrontier } from './native-program-frontier';
import type { NativeModuleObservation } from './native-program-requests';
import { createNativeProgramSnapshot } from './native-program-snapshot';
import {
  assertNativeObservationInputs,
  nativeRootFailures,
} from './native-program-validity';
import type { NativeReferenceObservation } from './reference-redirect';
import {
  createNativeRuntimeModuleQuery,
  type NativeRuntimeModuleQuery,
} from './runtime-module-queries';

export interface NativeProgramObservationOptions {
  project: TypeScriptSemanticProject;
  context: NativeEvidenceContext;
  coverage: SourceConfigCoverageIndex;
  observationRootNames?: readonly string[];
  metrics?: AnalysisMetricsRecorder;
  queries?: BoundedResolutionQueries;
  profileRole?: 'type-evidence';
  collectSyntaxParents?: boolean;
  syntaxFiles?: ReadonlySet<string>;
}

/**
 * The compiler generates requests. The host refuses SourceFile creation beyond
 * Coverage. No filtered resolution, old Program, checker, or fallback is used.
 */
export class NativeObservationAdapter {
  readonly program: ts.Program;
  readonly snapshot: NativeEvidenceSnapshot;
  readonly modules: readonly NativeModuleObservation[];
  readonly configReads: readonly string[];
  readonly frontier: NativeProgramFrontier;
  readonly options: NativeProgramObservationOptions;
  readonly references: ReadonlyMap<string, NativeReferenceObservation>;
  readonly createRuntimeModuleQuery: () => NativeRuntimeModuleQuery;

  constructor(
    options: NativeProgramObservationOptions,
    compiler: typeof ts = ts,
  ) {
    assertNativeProgramCompiler(compiler);
    assertNativeObservationInputs(options, compiler);
    this.options = options;
    const { project, context, coverage } = options;
    this.frontier = new NativeProgramFrontier(
      project.sourceConfigPath ?? project.configPath,
      project.fileNames,
      coverage,
      project.declarationContextValidation,
      compilerPathPolicy(
        compiler,
        compiler.createCompilerHost(project.options),
      ).key,
    );
    const observationRootNames = [
      ...(options.observationRootNames ?? project.fileNames),
    ];
    if (
      options.observationRootNames !== undefined &&
      observationRootNames.some((root) => !this.frontier.isProjectRoot(root))
    )
      throw new NativeObservationError(
        'input-drift',
        'Native observation roots must belong to the current project.',
      );
    const { program, host, modules, requests, loads, configReads, failures } =
      createBoundedProgramClosure(
        { ...options, observationRootNames },
        compiler,
        this.frontier,
      );
    this.program = program;
    this.modules = modules;
    this.references = loads.references;
    this.configReads = Object.freeze(configReads);
    const snapshot = createNativeProgramSnapshot({
      program,
      frontier: this.frontier,
      requests,
      failures: [
        ...failures,
        ...nativeRootFailures({
          contextId: context.id,
          observationRootNames,
          program,
          frontier: this.frontier,
        }).filter((failure) =>
          failures.every(
            (prior) => prior.evidenceIds[0] !== failure.evidenceIds[0],
          ),
        ),
      ],
      obligations: collectNativeObligations({
        context,
        compiler,
        program,
        frontier: this.frontier,
        requests,
        paths: loads.paths,
        modules: this.modules,
        references: this.references,
      }),
    });
    this.snapshot = freezeNativeData(snapshot);
    this.frontier.identities.assertStable();
    assertNativeObservationInputs(options, compiler);
    this.createRuntimeModuleQuery = () =>
      createNativeRuntimeModuleQuery(compiler, program, host, this.configReads);
  }
}
