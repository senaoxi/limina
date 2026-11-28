import { analysisHash } from '#utils/analysis-hash';
import { normalizeAbsolutePath } from '#utils/path';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { ANALYSIS_ADAPTER } from './contracts';

export { analysisHash } from '#utils/analysis-hash';

// Roots and the workspace boundary are compared as project state and per-target
// conditions. They are deliberately absent from this cross-process identity.
export function nativeContextId(project: TypeScriptSemanticProject): string {
  return analysisHash({
    adapter: ANALYSIS_ADAPTER,
    config: normalizeAbsolutePath(project.configPath),
    sourceConfig: project.sourceConfigPath,
    options: effectiveCompilerOptions(project.options),
    admission: project.admissionMode,
    binding: project.analysisBinding,
    compilationScope: project.compilationObligationScope,
    references: project.projectReferences,
    declarationValidation: project.declarationContextValidation,
  });
}
