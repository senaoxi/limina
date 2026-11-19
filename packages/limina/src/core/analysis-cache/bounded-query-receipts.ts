import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type {
  ImporterRecord,
  NativeContextRecord,
  ResolutionRecord,
} from './contracts';

export function boundedQueryReceipts(
  queries: Record<string, ResolutionRecord>,
  ids: Iterable<string>,
): Record<string, string> {
  return Object.fromEntries(
    Array.from(ids, (id) => [id, nativeFingerprint(queries[id])]),
  );
}

export function hasBoundedQueryReceipts(
  context: NativeContextRecord,
  contextId: string,
  importers: Record<string, ImporterRecord>,
  queries: Record<string, ResolutionRecord>,
): boolean {
  const receipts = context.native?.queryReceipts;
  if (!receipts || Object.keys(receipts).length !== context.queryIds.length)
    return false;
  const byFile = new Map<string, Set<string>>();
  for (const key of context.queryIds) {
    const query = queries[key];
    if (
      !query ||
      query.contextId !== contextId ||
      receipts[key] !== nativeFingerprint(query)
    )
      return false;
    const keys = byFile.get(query.file) ?? new Set<string>();
    if (keys.has(key)) return false;
    keys.add(key);
    byFile.set(query.file, keys);
  }
  return Object.entries(context.sources).every(([file, id]) => {
    const keys = byFile.get(file) ?? new Set<string>();
    const importer = id === null ? undefined : importers[id];
    return (
      importer !== undefined &&
      importer.queryIds.length === keys.size &&
      keys.isSubsetOf(new Set(importer.queryIds))
    );
  });
}
