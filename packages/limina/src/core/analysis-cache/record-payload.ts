import { isPlainRecord } from '#utils/values';
import { constants } from 'node:buffer';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateRawSync,
  inflateRawSync,
  constants as zlibConstants,
} from 'node:zlib';
import { z } from 'zod';
import { decodeData, encodeData } from './data-codec';

const payloadSchema = z.strictObject({
  analysisRecord: z.string(),
  byteLength: z.number().int().min(1).max(constants.MAX_STRING_LENGTH),
  format: z.enum(['json', 'data']),
  compression: z.enum(['deflate', 'brotli']).optional(),
});

export function packAnalysisRecord(
  value: unknown,
  format: 'json' | 'data',
  compression: 'deflate' | 'brotli' = 'deflate',
): unknown {
  const text = recordText(value, format);
  if (text.length < 1024) return value;
  return {
    analysisRecord: compress(text, compression).toString('base64'),
    byteLength: Buffer.byteLength(text),
    format,
    compression,
  };
}
function recordText(value: unknown, format: 'json' | 'data'): string {
  return JSON.stringify(format === 'data' ? encodeData(value) : value);
}
function compress(text: string, compression: 'deflate' | 'brotli'): Buffer {
  return compression === 'brotli'
    ? brotliCompressSync(text, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      })
    : deflateRawSync(text);
}

export function unpackAnalysisRecord(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  return Object.hasOwn(value, 'analysisRecord') ? unpack(value) : value;
}

function unpack(value: unknown): unknown {
  const payload = payloadSchema.parse(value);
  const decompress = decompressor(payload.compression);
  const bytes = decompress(Buffer.from(payload.analysisRecord, 'base64'), {
    maxOutputLength: payload.byteLength,
  });
  if (bytes.length !== payload.byteLength)
    throw new Error('Incomplete analysis record payload.');
  const decoded: unknown = JSON.parse(bytes.toString('utf8'));
  return payload.format === 'data' ? decodeData(decoded) : decoded;
}
function decompressor(
  compression: 'deflate' | 'brotli' | undefined,
): typeof inflateRawSync {
  return compression === 'brotli' ? brotliDecompressSync : inflateRawSync;
}

export function mapAnalysisRecords(
  groups: Record<string, unknown>,
  transform: (record: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(groups).map(([key, records]) => [
      key,
      mapGroup(records, transform),
    ]),
  );
}

function mapGroup(
  value: unknown,
  transform: (record: unknown) => unknown,
): unknown {
  return isPlainRecord(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, record]) => [key, transform(record)]),
      )
    : value;
}
