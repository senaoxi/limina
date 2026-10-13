import { z } from 'zod';
const text = z.string();
const optionalNumber = z.number().optional();
export const occurrenceSchema: z.ZodType<unknown> = z.object({
  filePath: text,
  domain: text,
  kind: text,
  line: z.number(),
  specifier: text,
  locator: z.object({
    occurrence: z.number(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
  }),
  configurationSource: z
    .object({
      configPath: text,
      option: z.literal('jsxImportSource'),
      resolutionMode: optionalNumber,
    })
    .optional(),
});
