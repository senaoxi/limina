import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { ANALYSIS_ADAPTER } from './contracts';

const trueVersion = hashJson('true');
const falseVersion = hashJson('false');

export function analysisHash(value: unknown): string {
  if (typeof value === 'boolean') return value ? trueVersion : falseVersion;
  return hashJson(JSON.stringify(value) ?? 'undefined');
}

function hashJson(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
