import type ts from 'typescript';
import { z } from 'zod';
import { decodeData, encodeData } from './data-codec';
import { resolutionOriginSchema } from './declaration-schema';
import { isRecordTableData } from './record-table';
import type { VueModuleRecord } from './vue-contracts';

type LiteralResolver = NonNullable<
  ts.LanguageServiceHost['resolveModuleNameLiterals']
>;
export type ModuleResult = ReturnType<LiteralResolver>[number];

const packageIdSchema = z.object({
  name: z.string(),
  version: z.string(),
  subModuleName: z.string(),
  peerDependencies: z.string().optional(),
});
const resolvedModuleSchema = z.looseObject({
  resolvedFileName: z.string(),
  originalPath: z.string().optional(),
  extension: z.string(),
  isExternalLibraryImport: z.boolean().optional(),
  resolutionOrigin: resolutionOriginSchema.optional(),
  packageId: packageIdSchema.optional(),
});
const resultSchema = z.looseObject({
  resolvedModule: resolvedModuleSchema.optional(),
  failedLookupLocations: z.array(z.string()).optional(),
  affectingLocations: z.array(z.string()).optional(),
  resolutionDiagnostics: z.undefined().optional(),
});

export function decodeVueModuleResult(data: unknown): ModuleResult | undefined {
  try {
    const parsed = resultSchema.safeParse(decodeData(data));
    return parsed.success ? (parsed.data as ModuleResult) : undefined;
  } catch {
    return undefined;
  }
}

export function encodeVueModuleResult(
  result: ModuleResult,
): VueModuleRecord['result'] | undefined {
  if (!resultSchema.safeParse(result).success) return undefined;
  try {
    return encodeData(result);
  } catch {
    return undefined;
  }
}

const qualified = new WeakSet<object>();

// Keep the original tagged value for replay. A privately reconstructed table
// already owns the JSON tree; mutable DTOs still need an independent copy.
export const vueModuleResultSchema: z.ZodType<unknown> = z
  .union([z.custom(isRecordTableData), z.json()])
  .refine((data) => {
    const isPrivateData = isRecordTableData(data);
    if (isPrivateData && qualified.has(data)) return true;
    if (decodeVueModuleResult(data) === undefined) return false;
    if (isPrivateData) qualified.add(data);
    return true;
  });
