import { statSync } from 'node:fs';

// The stamps only accelerate invocation-local validation of the stable descriptor set.
export function descriptorStamp(file: string): string | undefined {
  const value = statSync(file, { bigint: true, throwIfNoEntry: false });
  return value === undefined || value.ino === 0n || value.ctimeNs <= 0n
    ? undefined
    : [value.dev, value.ino, value.mtimeNs, value.ctimeNs].join(':');
}
