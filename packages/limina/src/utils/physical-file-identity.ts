import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'pathe';
import { normalizeAbsolutePath } from './path';

export type PhysicalFileIdentity =
  | {
      state: 'verified';
      canonicalPath: string;
      canonicalId: string;
      size: string;
      mtime: string;
      ctime: string;
    }
  | { state: 'unavailable'; reason: string };

interface PhysicalRound {
  parents: Map<string, string>;
  names: Map<string, ReadonlySet<string> | null>;
  identities: Map<string, PhysicalFileIdentity>;
}
const physicalRounds = new AsyncLocalStorage<PhysicalRound>();

/**
Only an explicit read-only replay owns these observations.
*/
export class PhysicalFileReplay {
  readonly #round: PhysicalRound = {
    parents: new Map(),
    names: new Map(),
    identities: new Map(),
  };

  run<T>(operation: () => T): T {
    return physicalRounds.run(this.#round, operation);
  }
}

function parentNames(
  parent: string,
  round: PhysicalRound,
): ReadonlySet<string> | null {
  if (round.names.has(parent)) return round.names.get(parent)!;
  let names: ReadonlySet<string> | null;
  try {
    names = new Set(readdirSync(parent));
  } catch {
    // Searching an executable directory need not require listing permission.
    names = null;
  }
  round.names.set(parent, names);
  return names;
}

/**
Native resolution remains authoritative for aliases and unknown spellings.
*/
export function resolvePhysicalPath(file: string, isLink?: boolean): string {
  const round = physicalRounds.getStore();
  // Native resolution owns dot segments and trailing directory symlinks.
  if (
    round === undefined ||
    process.platform === 'win32' ||
    file !== normalizeAbsolutePath(file)
  )
    return normalizeAbsolutePath(realpathSync.native(file));
  const parent = path.dirname(file);
  if (parent === file || (isLink ?? lstatSync(file).isSymbolicLink()))
    return normalizeAbsolutePath(realpathSync.native(file));
  const names = parentNames(parent, round);
  if (!names?.has(path.basename(file)))
    return normalizeAbsolutePath(realpathSync.native(file));
  let canonical = round.parents.get(parent);
  if (canonical === undefined) {
    canonical = normalizeAbsolutePath(realpathSync.native(parent));
    round.parents.set(parent, canonical);
  }
  return path.join(canonical, path.basename(file));
}

/**
Membership and canonical binding do not assert content freshness.
*/
export function readPhysicalFileBinding(
  file: string,
):
  | Pick<
      Extract<PhysicalFileIdentity, { state: 'verified' }>,
      'state' | 'canonicalPath' | 'canonicalId'
    >
  | Extract<PhysicalFileIdentity, { state: 'unavailable' }> {
  const identity = readPhysicalFileIdentity(file);
  return identity.state === 'unavailable'
    ? identity
    : {
        state: identity.state,
        canonicalPath: identity.canonicalPath,
        canonicalId: identity.canonicalId,
      };
}

/**
Replayable physical identity; no analysis epoch or owner is manufactured.
*/
export function readPhysicalFileIdentity(file: string): PhysicalFileIdentity {
  const identities = physicalRounds.getStore()?.identities;
  const previous = identities?.get(file);
  if (previous !== undefined) return { ...previous };
  const current = observePhysicalFileIdentity(file);
  identities?.set(file, current);
  return { ...current };
}

function observePhysicalFileIdentity(file: string): PhysicalFileIdentity {
  try {
    const canonicalPath = resolvePhysicalPath(file);
    const stat = statSync(canonicalPath, { bigint: true });
    if (!isVerifiedFile(stat))
      return { state: 'unavailable', reason: 'unverified-file-identity' };
    return {
      state: 'verified',
      canonicalPath,
      canonicalId: `${stat.dev}:${stat.ino}`,
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs),
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
