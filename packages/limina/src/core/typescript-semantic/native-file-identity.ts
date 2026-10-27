import { readAnalysisInput } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { readPhysicalFileBinding } from '#utils/physical-file-identity';
import { createHash } from 'node:crypto';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';
import { isPublishedNativeData } from '../../domain/analysis/native-evidence-freeze';

const fingerprints = new WeakMap<object, string>();

export function nativeFingerprint(value: unknown): string {
  // Schema decoding may change object insertion order; ordered roots/references
  // still retain array order. A proof identity must survive a JSON round trip.
  const isImmutable = isPublishedNativeData(value);
  const previous = isImmutable ? fingerprints.get(value) : undefined;
  if (previous !== undefined) return previous;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(value, canonicalFields))
    .digest('hex');
  if (isImmutable) fingerprints.set(value, fingerprint);
  return fingerprint;
}

function canonicalFields(_key: string, value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          compareCodeUnits(left, right),
        ),
      )
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return [
    value !== null,
    typeof value === 'object',
    !Array.isArray(value),
  ].every(Boolean);
}
/**
 * A lexical path is not proof of physical identity. In particular, a missing
 * output or an unreadable symlink must not acquire membership by its spelling.
 */
export function observeNativeFileIdentity(
  fileName: string,
  inputVersion: string,
): NativeFileIdentity {
  const lexicalPath = normalizeAbsolutePath(fileName);
  const receipt = readAnalysisInput(
    lexicalPath,
    () => readPhysicalFileBinding(lexicalPath),
    'file-binding',
  );
  return {
    lexicalPath,
    physical:
      receipt.state === 'unavailable'
        ? receipt
        : {
            state: 'verified',
            canonicalId: receipt.canonicalId,
            inputVersion,
            // Membership is a path/inode fact. Content and metadata remain
            // independent replayed inputs, rather than changing the entire
            // configuration universe after an unrelated source body edit.
            evidenceId: nativeFingerprint([
              lexicalPath,
              receipt.canonicalPath,
              receipt.canonicalId,
            ]),
          },
  };
}
