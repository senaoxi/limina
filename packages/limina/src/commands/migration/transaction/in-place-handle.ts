import type { FileHandle } from 'node:fs/promises';
import {
  createPreparedIdentity,
  normalizeStat,
  validationIo,
} from './file-stat';
import type { PreparedFileIdentity } from './types';

function toSupportedByteLength(size: bigint, filePath: string): number {
  const byteLength = Number(size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`Unsupported file size for ${filePath}: ${size}`);
  }
  return byteLength;
}

async function readHandleChunk(options: {
  bytes: Buffer;
  filePath: string;
  handle: FileHandle;
  length: number;
  offset: number;
}) {
  return validationIo(`Unable to read ${options.filePath}`, () =>
    options.handle.read(
      options.bytes,
      options.offset,
      options.length,
      options.offset,
    ),
  );
}

async function readHandleBytes(
  handle: FileHandle,
  byteLength: number,
  filePath: string,
): Promise<Buffer> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const result = await readHandleChunk({
      bytes,
      filePath,
      handle,
      length: byteLength - offset,
      offset,
    });
    if (result.bytesRead === 0) {
      throw new Error(`Unexpected end of file while reading ${filePath}`);
    }
    offset += result.bytesRead;
  }
  return bytes;
}

export async function readHandleIdentity(options: {
  filePath: string;
  handle: FileHandle;
}): Promise<{ bytes: Buffer; identity: PreparedFileIdentity }> {
  const fileStat = normalizeStat(
    await validationIo(`Unable to stat open target ${options.filePath}`, () =>
      options.handle.stat({ bigint: true }),
    ),
  );
  const bytes = await readHandleBytes(
    options.handle,
    toSupportedByteLength(fileStat.size, options.filePath),
    options.filePath,
  );
  return { bytes, identity: createPreparedIdentity(bytes, fileStat) };
}
