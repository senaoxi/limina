import { isNativeTypeScriptProjectInput } from '#checkers';
import { readAnalysisInput } from '#utils/analysis-input';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { TypeScriptSemanticProject } from './contracts';
import { nativeFingerprint } from './native-file-identity';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import { createNativeObservationContext } from './native-observation-context';
import { NativeObservationError } from './native-observation-failure';

const require = createRequire(import.meta.url);

/**
Actual loaded baseline and input identity, independent of final Checker startup.
*/
export function nativeContextInputs(
  input: TypeScriptSemanticProject,
): NativeProgramObservationOptions {
  const project = {
    ...input,
    fileNames: input.fileNames.filter(isNativeTypeScriptProjectInput),
  };
  const coverage =
    project.workspaceSourceBoundary.sourceConfigCoverage ??
    unavailableCoverage(project);
  const compilerPath = require.resolve('typescript');
  const implementation = readAnalysisInput(
    compilerPath,
    () => ts.sys.readFile(compilerPath),
    'typescript-content',
  );
  if (implementation === undefined)
    throw new NativeObservationError(
      'file-read',
      `Cannot read the loaded TypeScript implementation: ${compilerPath}`,
    );
  const sourceVersion = nativeFingerprint(
    project.fileNames.map((file) => [
      file,
      readAnalysisInput(
        file,
        () => project.virtualFiles?.get(file) ?? ts.sys.readFile(file),
        'typescript-content',
      ),
    ]),
  );
  const authority = nativeAuthority(project);
  return {
    project,
    coverage,
    context: createNativeObservationContext({
      project,
      coverage,
      sourceVersion,
      authority,
      epoch: coverage.inputVersion,
      collectionId: randomUUID(),
      typescriptVersion: ts.version,
      typescriptImplementation: nativeFingerprint([
        compilerPath,
        implementation,
      ]),
      toolchain: nativeFingerprint([process.execPath, process.versions]),
    }),
  };
}

function nativeAuthority(
  project: TypeScriptSemanticProject,
): NativeEvidenceContext['authority'] {
  if (project.analysisBinding?.phase === 'locked')
    return {
      phase: 'locked',
      family: 'typescript',
      selectionEvidenceIds: [
        nativeFingerprint(['native-baseline', project.analysisBinding]),
      ],
    };
  return { phase: 'pending', baseline: 'typescript' };
}

function unavailableCoverage(
  project: TypeScriptSemanticProject,
): SourceConfigCoverageIndex {
  const id = nativeFingerprint(['unavailable-universe', project.configPath]);
  return {
    inputVersion: 'unavailable',
    configurations: [],
    universe: {
      id,
      revision: id,
      scopeFingerprint: id,
      inputVersion: 'unavailable',
      selectionEvidenceId: 'source-config-universe-not-provided',
      sourceConfigIds: [],
      discovery: 'open',
    },
  };
}
