import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Read every byte without retaining a complete executable in memory.
export function digestFile(file: string): { hash: string; length: number } {
  const descriptor = openSync(file, 'r');
  try {
    const size = Math.max(
      4096,
      Math.min(fstatSync(descriptor).size, 256 * 1024),
    );
    const buffer = Buffer.allocUnsafe(size);
    const hash = createHash('sha256');
    let length = 0;
    let count = readSync(descriptor, buffer, 0, buffer.length, null);
    while (count > 0) {
      hash.update(buffer.subarray(0, count));
      length += count;
      count = readSync(descriptor, buffer, 0, buffer.length, null);
    }
    return { hash: hash.digest('hex'), length };
  } finally {
    closeSync(descriptor);
  }
}
