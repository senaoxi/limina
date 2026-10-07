import { z } from 'zod';
const text = z.string();
const texts = z.array(text);
const file = z.object({ kind: z.literal('file'), path: text });
const tsContent = z.object({
  kind: z.literal('typescript-content'),
  path: text,
});
const content = z.object({ kind: z.literal('content'), path: text });
const directoryArguments = z.tuple([
  text,
  texts.nullable(),
  texts.nullable(),
  texts.nullable(),
  z.number().nullable(),
]);
const directory = z.object({
  kind: z.literal('ts-directory'),
  arguments: directoryArguments,
});
const globOptions = z.object({
  absolute: z.literal(true),
  cwd: text,
  onlyDirectories: z.boolean().optional(),
  onlyFiles: z.boolean().optional(),
  expandDirectories: z.boolean().optional(),
  dot: z.boolean().optional(),
  followSymbolicLinks: z.boolean().optional(),
  ignore: texts,
});
const glob = z.object({
  kind: z.literal('glob'),
  patterns: texts,
  options: globOptions,
  lexicalDirectories: z.boolean().optional(),
});
const descriptor = z.discriminatedUnion('kind', [
  file,
  content,
  tsContent,
  directory,
  glob,
]);
export const discoveryRecordSchema: z.ZodType<unknown> = z.object({
  key: text,
  path: text,
  version: text,
  binding: text,
  descriptor,
});
