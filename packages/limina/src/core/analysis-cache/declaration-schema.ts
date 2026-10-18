import { normalizeAbsolutePath } from '#utils/path';
import { z } from 'zod';
import type { DeclarationEntry } from '../typescript-semantic/declaration-closure';
import type { ResolutionOrigin } from '../typescript-semantic/resolution-origin';

export const resolutionOriginSchema: z.ZodType<ResolutionOrigin> = z.object({
  version: z.literal(1),
  compiler: z.string(),
  route: z.enum(['local', 'package', 'type-root', 'incomplete']),
  target: z.string(),
  originalPath: z.string().optional(),
});
export const requestEligibilitySchema: z.ZodType<{
  governance: boolean;
  expansion: boolean;
}> = z.object({ governance: z.boolean(), expansion: z.boolean() });
export const declarationEntrySchema: z.ZodType<DeclarationEntry> = z
  .object({
    kind: z.enum(['root', 'type-environment', 'framework-environment']),
    fileName: z.string(),
    name: z.string().optional(),
    origin: resolutionOriginSchema.optional(),
  })
  .refine(
    (entry) =>
      entry.kind === 'root' ||
      hasDeclarationReceipt({
        resolvedFileName: entry.fileName,
        resolutionOrigin: entry.origin,
      }),
  );

export function hasDeclarationReceipt(target: {
  resolvedFileName: string;
  resolutionOrigin?: ResolutionOrigin;
}): boolean {
  if (!/\.d\.[cm]?ts$/.test(target.resolvedFileName)) return true;
  const origin = target.resolutionOrigin;
  if (origin === undefined) return false;
  return [
    origin.version === 1,
    origin.target === normalizeAbsolutePath(target.resolvedFileName),
    origin.route !== 'incomplete',
    /^(?:5\.[4-9]|6\.0)\./.test(origin.compiler),
  ].every(Boolean);
}
