import { z } from 'zod';

export const text: z.ZodString = z.string();
export const texts: z.ZodType<unknown> = z.array(text);
export const checker: z.ZodType<unknown> = z.enum(['tsc', 'tsgo']);
export function stringMap<T>(value: z.ZodType<T>): z.ZodType<Map<string, T>> {
  return z.custom<Map<string, T>>(
    (input) =>
      input instanceof Map &&
      [...input].every(
        ([key, item]) =>
          typeof key === 'string' && value.safeParse(item).success,
      ),
  );
}
export const stringSet: z.ZodType<unknown> = z.custom<Set<string>>(
  (input) =>
    input instanceof Set &&
    [...input].every((item) => typeof item === 'string'),
);
