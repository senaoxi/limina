import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import {
  type NativeModulePremises,
  observeModulePremises,
} from './native-context-inventory';
import {
  evaluateModuleImpact,
  independentModuleInputAbsenceForRoot,
  type NativeModuleImpact,
} from './native-module-impact';
import {
  artifact,
  existence,
  obligationIdentity,
  type ObligationSite,
  structure,
  targetConfig,
} from './native-obligation-projection';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeModuleObservation } from './native-program-requests';
import type { NativeReferenceObservation } from './reference-redirect';

interface ObligationInput {
  sourceLoadGap?: string;
  compiler: typeof ts;
  context: NativeEvidenceContext;
  frontier: NativeProgramFrontier;
  program: NativeObservedProgram;
  observation: NativeModuleObservation;
  references: ReadonlyMap<string, NativeReferenceObservation>;
}

interface ModuleProjection extends ObligationSite {
  compiler: typeof ts;
  frontier: NativeProgramFrontier;
  options: ts.CompilerOptions;
  premises: Omit<
    NativeModulePremises,
    'requestId' | 'sourceFingerprint' | 'targetExtension'
  >;
  target?: ts.ResolvedModuleFull;
  completed: boolean;
  reference?: NativeReferenceObservation;
}

export function createNativeModuleObligation(
  input: ObligationInput,
): NativeCompilationObligation {
  const { context, observation, compiler, program, frontier } = input;
  const target = observation.raw?.resolvedModule;
  return projectNativeModuleObligation({
    context,
    compiler,
    frontier,
    requestId: observation.requestId,
    options: program.getCompilerOptions(),
    premises: {
      ...observeModulePremises(observation, program, compiler),
      sourceLoadGap: input.sourceLoadGap,
    },
    target,
    completed: observation.raw !== undefined,
    reference:
      target === undefined
        ? undefined
        : input.references.get(target.resolvedFileName),
  });
}

export function projectNativeModuleObligation(
  input: ModuleProjection,
): NativeCompilationObligation {
  const absent = independentAbsence(input);
  const target = input.target;
  const identity = obligationIdentity(input);
  if (target === undefined)
    return {
      ...identity,
      targetConfigId: null,
      existence: existence(input, absent ?? unresolvedImpact(input)),
      structure: { state: 'unknown', reason: 'no-proven-target' },
      artifact: { state: 'unknown', reason: 'no-proven-producer' },
    };
  const reference = input.reference;
  const configId = targetConfig(
    input.frontier.inspect(target.resolvedFileName).coverage,
    reference,
  );
  return {
    ...identity,
    targetConfigId: configId,
    existence: existence(input, absent ?? resolvedImpact(input, target)),
    structure: structure(input, configId, reference),
    artifact: artifact(
      reference?.state === 'observed' ? reference.redirect : undefined,
    ),
  };
}

function independentAbsence(
  input: ModuleProjection,
): NativeModuleImpact | undefined {
  return independentModuleInputAbsenceForRoot(
    {
      role: input.premises.role,
      options: input.premises.options,
      target: input.target?.resolvedFileName,
    },
    (file) => input.frontier.isProjectRoot(file),
  );
}

function unresolvedImpact(input: ModuleProjection): NativeModuleImpact {
  if (input.premises.ownAmbient)
    return { state: 'absent', rule: 'compiler-local-ambient-module' };
  return input.completed
    ? {
        state: 'absent',
        rule: 'compiler-completed-resolution-without-file-input',
      }
    : {
        state: 'unknown',
        reason: 'compiler-resolution-observation-unavailable',
      };
}

function resolvedImpact(
  input: ModuleProjection,
  target: ts.ResolvedModuleFull,
): NativeModuleImpact {
  const { premises } = input;
  const impact = evaluateModuleImpact({
    target,
    compiler: input.compiler,
    reference: input.reference,
    inputOptions: premises.options,
    emitOptions: input.options,
    sourceIsExternal: premises.sourceIsExternal,
    sourceIsDeclaration: premises.sourceIsDeclaration,
    excludedDocumentation: premises.excludedDocumentation,
  });
  if (impact.state !== 'present') return impact;
  if (premises.sourceLoadGap !== undefined)
    return { state: 'unknown', reason: premises.sourceLoadGap };
  return input.options.composite === true ||
    input.context.inputs.compilationScope === 'generated-declaration-project-v1'
    ? impact
    : {
        state: 'unknown',
        reason: 'fixed-root-composite-compilation-scope-not-established',
      };
}
