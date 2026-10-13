import { isPlainRecord } from '#utils/values';
import { z } from 'zod';
import type { InputDependency } from './contracts';

const shared = new WeakSet<object>();
const shape = z.object({ inputId: z.string(), expectedVersion: z.string() });

export function shareValidatedDependency(
  value: InputDependency,
): InputDependency {
  const parsed = Object.freeze(shape.parse(value));
  shared.add(parsed);
  return parsed;
}

// Only privately validated, frozen table entries may retain object identity.
// Ordinary DTOs still pass the full shape parser and receive an owned copy.
export const dependencySchema: z.ZodType<InputDependency> = z.union([
  z.custom<InputDependency>(
    (value) => isPlainRecord(value) && shared.has(value),
  ),
  shape,
]);
