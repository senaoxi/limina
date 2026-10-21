import type ts from 'typescript';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { effectiveCompilerOptions } from './compiler-options';
import { nativeFingerprint } from './native-file-identity';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import { NativeObservationError } from './native-observation-failure';
import { NATIVE_PROGRAM_ADAPTER } from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';

/**
 * DTO qualifications cannot be rebound to new roots/options/coverage. The run
 * owner additionally validates source/config/epoch subscriptions before publish.
 */
export function assertNativeObservationInputs(
  options: NativeProgramObservationOptions,
  compiler: typeof ts,
): void {
  const { inputs } = options.context;
  const expected = [
    compiler.version,
    NATIVE_PROGRAM_ADAPTER,
    options.project.configPath,
    nativeFingerprint(options.project.fileNames),
    nativeFingerprint(effectiveCompilerOptions(options.project.options)),
    nativeFingerprint(options.project.projectReferences ?? []),
    nativeFingerprint(options.coverage),
    compilationScope(options),
  ];
  const actual = [
    inputs.typescriptVersion,
    inputs.hostContract,
    inputs.config,
    inputs.roots,
    inputs.options,
    inputs.rawReferences,
    inputs.coverage,
    inputs.compilationScope,
  ];
  if (actual.some((value, index) => value !== expected[index]))
    throw new NativeObservationError(
      'input-drift',
      'Native observation context input drift.',
    );
}

function compilationScope(options: NativeProgramObservationOptions): string {
  return options.project.compilationObligationScope ?? 'source-options';
}

export function nativeRootFailures(
  options: NativeProgramObservationOptions,
  program: ts.Program,
  frontier: NativeProgramFrontier,
): NativeEvidenceFailure[] {
  return options.project.fileNames
    .filter((file) => program.getSourceFile(file) === undefined)
    .filter((file) => !isBoundedRootStop(frontier, file))
    .map((file) => ({
      id: nativeFingerprint(['missing-root', options.context.id, file]),
      kind: 'identity',
      detail: `Root input was not loaded: ${file}`,
      evidenceIds: [file],
      affected: {
        kind: 'entries',
        contextId: options.context.id,
        entryIds: [file],
      },
    }));
}

function isBoundedRootStop(
  frontier: NativeProgramFrontier,
  file: string,
): boolean {
  const attempt = frontier.inspect(file);
  return (
    attempt.file.physical.state === 'verified' &&
    attempt.decision.action === 'stop'
  );
}
