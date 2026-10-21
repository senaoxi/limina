import { isNativeTypeScriptProjectInput } from '#checkers';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';

/**
Reuse observations only under the same pending baseline inputs.
*/
export function qualifiedPendingContext(
  context: TypeScriptSemanticDependencyContext | undefined,
  project: TypeScriptSemanticProject,
): TypeScriptSemanticDependencyContext | undefined {
  const observed = pendingObservation(context);
  if (observed === undefined) return undefined;
  const expected = pendingInputs(project);
  return [
    observed.authority.phase === 'pending',
    Object.entries(expected).every(
      ([key, value]) => observed.inputs[key as keyof typeof expected] === value,
    ),
  ].every(Boolean)
    ? context
    : undefined;
}

function pendingObservation(
  context: TypeScriptSemanticDependencyContext | undefined,
) {
  return context?.nativeEvidence?.contexts[0];
}
function pendingInputs(project: TypeScriptSemanticProject) {
  return {
    config: project.configPath,
    roots: nativeFingerprint(
      project.fileNames.filter(isNativeTypeScriptProjectInput),
    ),
    options: nativeFingerprint(effectiveCompilerOptions(project.options)),
    rawReferences: nativeFingerprint(project.projectReferences ?? []),
    coverage: nativeFingerprint(
      project.workspaceSourceBoundary.sourceConfigCoverage ?? null,
    ),
    compilationScope: pendingScope(project),
  };
}
function pendingScope(project: TypeScriptSemanticProject): string {
  return project.compilationObligationScope ?? 'source-options';
}
