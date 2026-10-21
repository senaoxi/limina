import { isNativeTypeScriptProjectInput } from '#checkers';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import {
  type DeclarationClosure,
  projectDeclarationClosure,
} from './declaration-closure';
import { projectObservedNativeClosure } from './native-closure-projection';

export function projectNativeDeclarationClosure(
  context: TypeScriptSemanticDependencyContext,
  project: TypeScriptSemanticProject,
  managedOutputLookup?: ManagedOutputDeclarationLookup,
): DeclarationClosure {
  return context.nativeEvidence === undefined
    ? projectLegacyNativeClosure(context, project, managedOutputLookup)
    : projectObservedNativeClosure(context, project);
}

function projectLegacyNativeClosure(
  context: TypeScriptSemanticDependencyContext,
  project: TypeScriptSemanticProject,
  managedOutputLookup?: ManagedOutputDeclarationLookup,
): DeclarationClosure {
  return projectDeclarationClosure({
    configPath: project.configPath,
    entries: [
      ...project.fileNames
        .filter(isNativeTypeScriptProjectInput)
        .map((fileName) => ({
          kind: 'root' as const,
          fileName,
        })),
      ...(context.getTypeEnvironmentEntries?.() ?? []),
    ],
    noResolve: project.options.noResolve,
    boundary: project.workspaceSourceBoundary,
    managedOutputLookup,
    records: (file) =>
      context.hasSourceFile(file) ? context.getImportRecords(file) : undefined,
    fact: (record) => {
      const fact = context.getDependencyFact(record);
      return { ...fact, target: fact.resolution.target };
    },
  });
}
