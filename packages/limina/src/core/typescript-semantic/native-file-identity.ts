import { readAnalysisInput } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { readPhysicalFileIdentity } from '#utils/physical-file-identity';
import { createHash } from 'node:crypto';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';

export function nativeFingerprint(value: unknown): string {
  // Schema decoding may change object insertion order; ordered roots/references
  // still retain array order. A proof identity must survive a JSON round trip.
  return createHash('sha256')
    .update(JSON.stringify(value, canonicalFields))
    .digest('hex');
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
    () => readPhysicalFileIdentity(lexicalPath),
    'file-identity',
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
            evidenceId: nativeFingerprint([lexicalPath, receipt]),
          },
  };
}
