import { z } from 'zod';
const text = z.string();
const optionalNumber = z.number().optional();
export const occurrenceSchema: z.ZodType<unknown> = z.object({
  compilerRequest: z
    .object({
      contextConfig: text,
      fileName: text,
      role: z.enum(['import', 'augmentation']),
      mode: optionalNumber,
      occurrence: z.number(),
      start: z.number(),
      end: z.number(),
    })
    .optional(),
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
      option: z.enum(['jsxImportSource', 'importHelpers']),
      resolutionMode: optionalNumber,
    })
    .optional(),
});
