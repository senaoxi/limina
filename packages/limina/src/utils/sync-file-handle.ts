import { fsync } from 'node:fs';
import { promisify } from 'node:util';

const syncDescriptor = promisify(fsync);

// Writable artifacts have physical descriptors even when a filesystem adapter wraps FileHandle.
export function syncFileHandle(handle: {
  fd?: number;
  sync(): Promise<void>;
}): Promise<void> {
  return handle.fd === undefined ? handle.sync() : syncDescriptor(handle.fd);
}
