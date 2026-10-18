import type ts from 'typescript';
import type { TypeScriptImportResolverOptions } from './import-resolver';
interface AdmissionInput {
  result: ts.ResolvedModuleWithFailedLookupLocations;
  containingFile: string;
  canExpand: boolean;
}
export function admitHostModuleResult(
  options: TypeScriptImportResolverOptions,
  input: AdmissionInput,
): ts.ResolvedModuleWithFailedLookupLocations {
  const resolved = input.result.resolvedModule;
  if (resolved === undefined) return input.result;
  return [input.canExpand, !options.project.options.noResolve].every(Boolean)
    ? filteredResult(options, input, resolved)
    : input.result;
}
function filteredResult(
  options: TypeScriptImportResolverOptions,
  input: AdmissionInput,
  resolved: ts.ResolvedModuleFull,
): ts.ResolvedModuleWithFailedLookupLocations {
  if (options.admission.allowModuleTarget(resolved, input.containingFile))
    return input.result;
  options.admission.exclude(resolved.resolvedFileName);
  return { ...input.result, resolvedModule: undefined };
}
