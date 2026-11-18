import { statSync } from 'node:fs';

/**
A cheap identity for a physical config read. Unknown identities require hashing.
*/
export function configFileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    // A coarse change time cannot distinguish an in-place rewrite with a restored mtime.
    return !stat.isFile() ||
      stat.ino === 0n ||
      stat.ctimeNs <= 0n ||
      stat.ctimeNs % 1_000_000n === 0n
      ? undefined
      : [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch {
    return undefined;
  }
}

// Only metadata bracketing the returned contents can certify a future hit.
export function readStampedConfig<T>(
  path: string,
  read: () => T,
  before: string | undefined,
): { value: T; configStamp?: string } {
  const value = read();
  return value !== undefined &&
    before !== undefined &&
    before === configFileStamp(path)
    ? { value, configStamp: before }
    : { value };
}
