import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import type {
  DeclarationClosure,
  DeclarationEntry,
} from './declaration-closure';
import type { NativeDependencyFact } from './dependency-fact';
import { createImportRecordIdentity } from './import-record';

/**
 * Compatibility view of already collected, physically bounded facts. No second
 * admission policy, package-origin exception, or source scan is applied here.
 * `governance` means available to that consumer, not a compliance verdict.
 */
export function projectObservedNativeClosure(
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
  const result: DeclarationClosure = {
    consumer: project.configPath,
    entries,
    entryStates: entries.map((entry) => ({
      governance: true,
      expansion: context.hasSourceFile(entry.fileName),
    })),
    links: [],
    records: [],
    requirements: [],
    incomplete: context.nativeEvidence!.failures.flatMap((failure) =>
      (failure.affected.kind === 'entries'
        ? failure.affected.entryIds
        : [project.configPath]
      ).map((fileName) => ({
        fileName,
        reason: `${failure.kind}: ${failure.detail}`,
      })),
    ),
  };
  const retained = new Set<string>();
  for (const [entry, source] of entries.entries())
    visitEntry({ context, result, entry, retained, file: source.fileName });
  return result;
}

function environmentEntries(context: TypeScriptSemanticDependencyContext) {
  return context.getTypeEnvironmentEntries?.() ?? [];
}

interface Traversal {
  context: TypeScriptSemanticDependencyContext;
  result: DeclarationClosure;
  retained: Set<string>;
  entry: number;
  file: string;
}

function visitEntry(input: Traversal): void {
  const visited = new Set<string>();
  const pending = [input.file];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    visitFile({ ...input, file }, pending);
  }
}

function visitFile(input: Traversal, pending: string[]): void {
  const { context, file } = input;
  for (const occurrence of context.getImportRecords(file)) {
    const fact = context.getDependencyFact(occurrence);
    const link = occurrenceLink(input, occurrence, fact);
    input.result.links.push(link);
    if (link.expansion) pending.push(link.target!);
    retainOccurrence(input, occurrence, fact);
  }
}

function occurrenceLink(
  input: Traversal,
  occurrence: ImportRecord,
  fact: NativeDependencyFact,
): DeclarationClosure['links'][number] {
  const target = fact.resolution.target?.resolvedFileName ?? null;
  const isExpansion = hasLoadedTarget(input.context, target);
  return {
    entry: input.entry,
    occurrence,
    target,
    expansion: isExpansion,
    governance: true,
    stop: linkStop(input.context, fact, isExpansion),
  };
}

function linkStop(
  context: TypeScriptSemanticDependencyContext,
  fact: NativeDependencyFact,
  isExpanded: boolean,
) {
  return isExpanded
    ? undefined
    : observedStop(context, fact.nativeEvidence?.requestId);
}

function hasLoadedTarget(
  context: TypeScriptSemanticDependencyContext,
  target: string | null,
) {
  return target !== null && context.hasSourceFile(target);
}

function retainOccurrence(
  input: Traversal,
  occurrence: ImportRecord,
  fact: NativeDependencyFact,
) {
  const key = createImportRecordIdentity(occurrence);
  if (input.retained.has(key)) return;
  input.retained.add(key);
  input.result.records.push(occurrence);
  if (fact.referenceRequirement !== null)
    input.result.requirements.push({
      occurrence,
      requirement: fact.referenceRequirement,
    });
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
