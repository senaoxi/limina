import type { ImportRecord } from '../import-analysis/records';
import type {
  ClosureFact,
  DeclarationClosure,
  DeclarationEntry,
} from '../typescript-semantic/declaration-closure';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';

/** Projection of inventoried requests only. The adapter owns loading and raw
 * facts; this traversal does not resolve, scan source text or select owners. */
export function projectObservedDeclarationClosure(input: {
  configPath: string;
  entries: readonly DeclarationEntry[];
  records(file: string): readonly ImportRecord[];
  loaded(file: string): boolean;
  fact(record: ImportRecord): ClosureFact;
  stop?(record: ImportRecord): string | undefined;
  incomplete: DeclarationClosure['incomplete'];
}): DeclarationClosure {
  const result: DeclarationClosure = {
    consumer: input.configPath,
    entries: [...input.entries],
    entryStates: input.entries.map((entry) => ({
      governance: true,
      expansion: input.loaded(entry.fileName),
    })),
    links: [],
    records: [],
    requirements: [],
    incomplete: input.incomplete,
  };
  const retained = new Set<string>();
  // A link retains one reachability witness, not every root-to-file path.
  // All predecessor requests remain links. Rewalking shared declaration or
  // root implementation inventories per entry produces a quadratic DTO.
  const visited = new Set<string>();
  for (const [entry, root] of input.entries.entries()) {
    const pending = [root.fileName];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const occurrence of input.records(file)) {
        const fact = input.fact(occurrence);
        const target = fact.target?.resolvedFileName ?? null;
        const stop = input.stop?.(occurrence);
        const isExpansion =
          stop === undefined &&
          target !== null &&
          input.loaded(target) &&
          fact.eligibility?.expansion !== false;
        result.links.push({
          entry,
          occurrence,
          target,
          expansion: isExpansion,
          governance: true,
          stop,
        });
        if (isExpansion) pending.push(target!);
        const key = createImportRecordIdentity(occurrence);
        if (retained.has(key)) continue;
        retained.add(key);
        result.records.push(occurrence);
        if (fact.referenceRequirement !== null)
          result.requirements.push({
            occurrence,
            requirement: fact.referenceRequirement,
          });
      }
    }
  }
  return result;
}
