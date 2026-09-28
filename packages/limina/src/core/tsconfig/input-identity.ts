import { createHash } from 'node:crypto';

/** Config overlays participate in semantic cache identity; no state is persisted. */
export function configInputIdentity(
  files: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (files === undefined) return undefined;
  const entries = [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
