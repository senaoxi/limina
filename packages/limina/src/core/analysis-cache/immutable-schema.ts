import { z } from 'zod';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { isDecodedRecord } from './record-table';

/**
A schema may reuse only its own successful parse of private immutable data.
*/
export function immutableNativeSchema<T>(schema: z.ZodType<T>): z.ZodType<T> {
  const parsed = new WeakMap<object, T>();
  const results = new WeakSet<object>();
  return z.transform((value, context): T => {
    if (value !== null && typeof value === 'object' && results.has(value))
      return value as T;
    if (isDecodedRecord(value) && parsed.has(value)) return parsed.get(value)!;
    const result = schema.safeParse(value);
    if (!result.success) {
      context.issues.push(
        ...result.error.issues.map((issue) => ({
          code: 'custom' as const,
          path: issue.path,
          message: issue.message,
          input: value,
        })),
      );
      return z.NEVER;
    }
    const data = freezeNativeData(result.data);
    if (data !== null && typeof data === 'object') results.add(data);
    if (isDecodedRecord(value)) parsed.set(value, data);
    return data;
  });
}
