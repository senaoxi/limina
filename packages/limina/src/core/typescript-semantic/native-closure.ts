import { isNativeTypeScriptProjectInput } from '#checkers';
import { projectObservedDeclarationClosure } from '../declaration-governance/projection';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import {
  type DeclarationClosure,
  type DeclarationEntry,
  projectDeclarationClosure,
} from './declaration-closure';

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

/**
 * Compatibility view of already collected, physically bounded facts. No second
 * admission policy, package-origin exception, or source scan is applied here.
 * `governance` means available to that consumer, not a compliance verdict.
 */
function projectObservedNativeClosure(
  context: TypeScriptSemanticDependencyContext,
  project: TypeScriptSemanticProject,
): DeclarationClosure {
  const entries: DeclarationEntry[] = [
    ...project.fileNames.map((fileName) => ({
      kind: 'root' as const,
      fileName,
    })),
    ...environmentEntries(context),
  ];
  return projectObservedDeclarationClosure({
    configPath: project.configPath,
    entries,
    records: (file) => context.getImportRecords(file),
    loaded: (file) => context.hasSourceFile(file),
    fact: (record) => {
      const fact = context.getDependencyFact(record);
      return { ...fact, target: fact.resolution.target };
    },
    stop: (record) =>
      observedStop(
        context,
        context.getDependencyFact(record).nativeEvidence?.requestId,
      ),
    incomplete: context.nativeEvidence!.failures.flatMap((failure) =>
      (failure.affected.kind === 'entries'
        ? failure.affected.entryIds
        : [project.configPath]
      ).map((fileName) => ({
        fileName,
        reason: `${failure.kind}: ${failure.detail}`,
      })),
    ),
  });
}

function environmentEntries(context: TypeScriptSemanticDependencyContext) {
  return context.getTypeEnvironmentEntries?.() ?? [];
}

function observedStop(
  context: TypeScriptSemanticDependencyContext,
  requestId: string | undefined,
) {
  const partition = context.nativeEvidence!.completeness.find(
    (item) => item.entryId === requestId && item.state === 'proven-stop',
  );
  return partition?.state === 'proven-stop' ? partition.stopReason : undefined;
}
