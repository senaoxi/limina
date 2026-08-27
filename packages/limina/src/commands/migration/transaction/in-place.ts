import type { FileHandle } from 'node:fs/promises';
import { restoreOriginalTimestamp } from './file-preparation';
import {
  assertContentMatches,
  assertStatMatches,
  hashBytes,
  normalizeStat,
  validationIo,
} from './file-stat';
import {
  validateCanonicalTarget,
  validateFile,
  validateTargetStat,
} from './file-validation';
import { readHandleIdentity } from './in-place-handle';
import type {
  ModifiedTargetSnapshot,
  PreparedFileIdentity,
  TransactionItem,
  TransactionRuntimeOptions,
} from './types';

function fullComparison() {
  return {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  } as const;
}

function stableIdentityComparison() {
  return {
    compareObservedMtime: false,
    compareRestorableMtime: false,
  } as const;
}

async function closeTargetHandle(options: {
  handle: FileHandle;
  item: TransactionItem;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  await options.handle.close();
  options.trackedHandles.delete(options.handle);
  options.item.targetHandle = undefined;
}

export async function openValidatedInPlaceTarget(options: {
  expected: PreparedFileIdentity;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<FileHandle> {
  const filePath = options.item.snapshot.item.configPath;
  await validateCanonicalTarget(options.item.snapshot);
  await validateFile({
    comparison: fullComparison(),
    expected: options.expected,
    filePath,
    readFileBytes: options.runtime.readFileBytes,
  });
  const handle = await validationIo(
    `Unable to open ${filePath} for writing`,
    () => options.runtime.openFile(filePath, 'r+'),
  );
  options.item.targetHandle = handle;
  options.trackedHandles.add(handle);
  const opened = await readHandleIdentity({ filePath, handle });
  assertStatMatches({
    actual: opened.identity.stat,
    comparison: fullComparison(),
    expected: options.expected.stat,
    filePath,
  });
  assertContentMatches({
    bytes: opened.bytes,
    expected: options.expected,
    filePath,
  });
  await validateCanonicalTarget(options.item.snapshot);
  await validateTargetStat({
    comparison: fullComparison(),
    expected: options.expected,
    filePath,
  });
  return handle;
}

async function writeHandleChunk(options: {
  bytes: Buffer;
  filePath: string;
  handle: FileHandle;
  length: number;
  offset: number;
  writeAt: TransactionRuntimeOptions['writeAt'];
}) {
  return validationIo(`Unable to write ${options.filePath}`, () =>
    options.writeAt({
      bytes: options.bytes,
      handle: options.handle,
      length: options.length,
      offset: options.offset,
      position: options.offset,
    }),
  );
}

async function writeAllAtPosition(options: {
  bytes: Buffer;
  filePath: string;
  handle: FileHandle;
  writeAt: TransactionRuntimeOptions['writeAt'];
}): Promise<void> {
  let offset = 0;
  while (offset < options.bytes.byteLength) {
    const requestedLength = options.bytes.byteLength - offset;
    const result = await writeHandleChunk({
      ...options,
      length: requestedLength,
      offset,
    });
    offset += validateWriteResult({
      filePath: options.filePath,
      requestedLength,
      result,
    });
  }
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function readBytesWritten(result: unknown): unknown {
  if (!isNonNullObject(result)) return undefined;
  return 'bytesWritten' in result ? result.bytesWritten : undefined;
}

function validateWriteResult(options: {
  filePath: string;
  requestedLength: number;
  result: unknown;
}): number {
  const observedBytesWritten = readBytesWritten(options.result);
  const bytesWritten =
    typeof observedBytesWritten === 'number'
      ? observedBytesWritten
      : Number.NaN;
  const valid = [
    Number.isSafeInteger(bytesWritten),
    bytesWritten > 0,
    bytesWritten <= options.requestedLength,
  ].every(Boolean);
  if (valid) return bytesWritten;
  throw new Error(
    `Invalid write result for ${options.filePath}: requested ${options.requestedLength} bytes, received ${String(observedBytesWritten)}`,
  );
}

export async function rewriteOpenTarget(options: {
  bytes: Buffer;
  handle: FileHandle;
  restoreTimestamp: boolean;
  snapshot: ModifiedTargetSnapshot;
  writeAt: TransactionRuntimeOptions['writeAt'];
}): Promise<void> {
  const filePath = options.snapshot.item.configPath;
  await writeAllAtPosition({
    bytes: options.bytes,
    filePath,
    handle: options.handle,
    writeAt: options.writeAt,
  });
  await validationIo(`Unable to truncate ${filePath}`, () =>
    options.handle.truncate(options.bytes.byteLength),
  );
  if (options.restoreTimestamp) {
    await restoreOriginalTimestamp(options.handle, options.snapshot);
  }
  await validationIo(`Unable to sync ${filePath}`, () => options.handle.sync());
}

export async function validateFailedInPlaceTargetIsOriginal(options: {
  handle: FileHandle;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
}): Promise<void> {
  await validatePotentiallyMutatedInPlaceTarget(options);
  const filePath = options.item.snapshot.item.configPath;
  const current = await readHandleIdentity({
    filePath,
    handle: options.handle,
  });
  assertStatMatches({
    actual: current.identity.stat,
    comparison: stableIdentityComparison(),
    expected: options.item.snapshot.stat,
    filePath,
  });
  assertContentMatches({
    bytes: current.bytes,
    expected: options.item.snapshot,
    filePath,
  });
  await validateCanonicalTarget(options.item.snapshot);
  await validateFile({
    comparison: stableIdentityComparison(),
    expected: options.item.snapshot,
    filePath,
    readFileBytes: options.runtime.readFileBytes,
  });
}

export async function captureCommittedInPlaceIdentity(options: {
  handle: FileHandle;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<PreparedFileIdentity> {
  const filePath = options.item.snapshot.item.configPath;
  const written = await readHandleIdentity({
    filePath,
    handle: options.handle,
  });
  assertStatMatches({
    actual: written.identity.stat,
    comparison: stableIdentityComparison(),
    expected: options.item.snapshot.stat,
    filePath,
  });
  assertContentMatches({
    bytes: written.bytes,
    expected: hashBytes(Buffer.from(options.item.snapshot.item.nextContent)),
    filePath,
  });
  await validateCanonicalTarget(options.item.snapshot);
  await validateFile({
    comparison: fullComparison(),
    expected: written.identity,
    filePath,
    readFileBytes: options.runtime.readFileBytes,
  });
  await closeTargetHandle({ ...options, handle: options.handle });
  return written.identity;
}

export async function validatePotentiallyMutatedInPlaceTarget(options: {
  handle: FileHandle;
  item: TransactionItem;
}): Promise<void> {
  const filePath = options.item.snapshot.item.configPath;
  await validateCanonicalTarget(options.item.snapshot);
  await validateTargetStat({
    comparison: stableIdentityComparison(),
    expected: options.item.snapshot,
    filePath,
  });
  const handleStat = normalizeStat(
    await validationIo(`Unable to stat open target ${filePath}`, () =>
      options.handle.stat({ bigint: true }),
    ),
  );
  assertStatMatches({
    actual: handleStat,
    comparison: stableIdentityComparison(),
    expected: options.item.snapshot.stat,
    filePath,
  });
}

export { closeTargetHandle };
