import ts from 'typescript';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import type {
  DirectSourceDependency,
  ProjectDependencyRequest,
} from './contracts';

export function getDirectResolutionMode(options: {
  evidence: CanonicalImportResolutionEvidence;
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): string {
  const frameworkMode = getFrameworkResolutionMode(options.evidence);
  if (frameworkMode !== undefined) return frameworkMode;
  const mode = getTypeScriptResolutionMode(options);
  return formatTypeScriptResolutionMode(mode);
}

function getFrameworkResolutionMode(
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  return evidence.semanticEvidence?.resolutionMode;
}

function getTypeScriptResolutionMode(options: {
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): ts.ResolutionMode | undefined {
  return options.request.typeScriptSemanticContext?.resolveImportRecord(
    options.importRecord,
  ).resolutionMode;
}

function formatTypeScriptResolutionMode(
  mode: ts.ResolutionMode | undefined,
): string {
  if (mode === undefined) return 'default';
  if (mode === ts.ModuleKind.CommonJS) return 'require';
  return 'import';
}
