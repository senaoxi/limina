import { isPlainRecord } from '#utils/values';
import { constants } from 'node:buffer';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { decodeData, encodeData } from './data-codec';

const payloadSchema = z.strictObject({
  analysisRecord: z.string(),
  byteLength: z.number().int().min(1).max(constants.MAX_STRING_LENGTH),
  format: z.enum(['json', 'data']),
});

export function packAnalysisRecord(
  value: unknown,
  format: 'json' | 'data',
): unknown {
  const text = JSON.stringify(format === 'data' ? encodeData(value) : value);
  if (text.length < 1024) return value;
  return {
    analysisRecord: deflateRawSync(text).toString('base64'),
    byteLength: Buffer.byteLength(text),
    format,
  };
}

export function unpackAnalysisRecord(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  return Object.hasOwn(value, 'analysisRecord') ? unpack(value) : value;
}

function unpack(value: unknown): unknown {
  const payload = payloadSchema.parse(value);
  const bytes = inflateRawSync(Buffer.from(payload.analysisRecord, 'base64'), {
    maxOutputLength: payload.byteLength,
  });
  if (bytes.length !== payload.byteLength)
    throw new Error('Incomplete analysis record payload.');
  const decoded: unknown = JSON.parse(bytes.toString('utf8'));
  return payload.format === 'data' ? decodeData(decoded) : decoded;
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
