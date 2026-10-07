import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { ANALYSIS_ADAPTER } from './contracts';

export function analysisHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
}

// Roots and the workspace boundary are compared as project state and per-target
// conditions. They are deliberately absent from this cross-process identity.
export function nativeContextId(project: TypeScriptSemanticProject): string {
  return analysisHash({
    adapter: ANALYSIS_ADAPTER,
    config: normalizeAbsolutePath(project.configPath),
    options: effectiveCompilerOptions(project.options),
    admission: project.admissionMode,
    binding: project.analysisBinding,
    references: project.projectReferences,
  });
}
