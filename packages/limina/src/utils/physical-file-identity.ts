import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { normalizeAbsolutePath } from './path';

export type PhysicalFileIdentity =
  | {
      state: 'verified';
      canonicalPath: string;
      canonicalId: string;
      size: string;
      mtime: string;
      contentHash: string;
    }
  | { state: 'unavailable'; reason: string };

/**
Replayable physical identity; no analysis epoch or owner is manufactured.
*/
export function readPhysicalFileIdentity(file: string): PhysicalFileIdentity {
  try {
    const canonicalPath = normalizeAbsolutePath(realpathSync.native(file));
    const stat = statSync(canonicalPath, { bigint: true });
    if (!isVerifiedFile(stat))
      return { state: 'unavailable', reason: 'unverified-file-identity' };
    return {
      state: 'verified',
      canonicalPath,
      canonicalId: `${stat.dev}:${stat.ino}`,
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      // Other installations can change ctime by adding/removing hardlinks.
      contentHash: createHash('sha256')
        .update(readFileSync(canonicalPath))
        .digest('hex'),
    };
  } catch (error) {
    return { state: 'unavailable', reason: identityFailure(error) };
  }
}

function isVerifiedFile(stat: { isFile(): boolean; ino: bigint }): boolean {
  return stat.isFile() && stat.ino !== 0n;
}

function identityFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'file-identity-unavailable';
  return 'code' in error ? String(error.code) : 'file-identity-unavailable';
}
