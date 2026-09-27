export const REGISTRY_METADATA_MAX_BYTES: number = 16 * 1024 * 1024;
export const REGISTRY_TARBALL_MAX_BYTES: number = 128 * 1024 * 1024;

export class RegistryBodyLimitError extends Error {
  override readonly name = 'RegistryBodyLimitError';
  readonly maxBytes: number;
  readonly receivedBytes: number | undefined;
  constructor(maxBytes: number, receivedBytes?: number) {
    super(`Registry response exceeds the ${maxBytes} byte limit`);
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

export async function cancelRegistryBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {
    /* Preserve the original failure if the body is already closed. */
  });
}

function declaredLengthExceedsLimit(
  response: Response,
  maxBytes: number,
): boolean {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/u.test(value)) return false;
  return BigInt(value) > BigInt(maxBytes);
}

function assertBodySize(receivedBytes: number, maxBytes: number): void {
  if (receivedBytes > maxBytes)
    throw new RegistryBodyLimitError(maxBytes, receivedBytes);
}

async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) return Buffer.concat(chunks, receivedBytes);
    receivedBytes += next.value.byteLength;
    assertBodySize(receivedBytes, maxBytes);
    chunks.push(next.value);
  }
}

export async function readRegistryBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (declaredLengthExceedsLimit(response, maxBytes)) {
    await cancelRegistryBody(response);
    throw new RegistryBodyLimitError(maxBytes);
  }
  if (response.body === null) return Buffer.alloc(0);
  return consumeBody(response.body.getReader(), maxBytes);
}

async function consumeBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  try {
    return await readChunks(reader, maxBytes);
  } catch (error) {
    await reader.cancel().catch(() => {
      /* Preserve the original failure if the body is already closed. */
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}
