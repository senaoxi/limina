import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { effectiveCompilerOptions } from './compiler-options';
import type { TypeScriptSemanticProject } from './contracts';
import { nativeFingerprint } from './native-file-identity';
import { NATIVE_PROGRAM_ADAPTER } from './native-program-api';

export function createNativeObservationContext(options: {
  project: TypeScriptSemanticProject;
  coverage: SourceConfigCoverageIndex;
  epoch: string;
  collectionId: string;
  sourceVersion: string;
  typescriptVersion: string;
  typescriptImplementation: string;
  toolchain: string;
  authority: NativeEvidenceContext['authority'];
}): NativeEvidenceContext {
  const { project } = options;
  const inputs = {
    typescriptVersion: options.typescriptVersion,
    typescriptImplementation: options.typescriptImplementation,
    toolchain: options.toolchain,
    hostContract: NATIVE_PROGRAM_ADAPTER,
    config: project.configPath,
    sourceConfig: project.sourceConfigPath ?? project.configPath,
    roots: nativeFingerprint(project.fileNames),
    options: nativeFingerprint(effectiveCompilerOptions(project.options)),
    rawReferences: nativeFingerprint(project.projectReferences ?? []),
    coverage: nativeFingerprint(options.coverage),
    sourceVersion: options.sourceVersion,
    compilationScope: project.compilationObligationScope ?? 'source-options',
  };
  return freezeNativeData({
    id: nativeFingerprint([
      inputs,
      options.epoch,
      options.collectionId,
      options.authority,
    ]),
    epoch: options.epoch,
    collectionId: options.collectionId,
    inputs,
    authority: options.authority,
  });
}
