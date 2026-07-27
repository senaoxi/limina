import {
  addConfigIssue,
  type ConfigValidationContext,
  isPlainConfigRecord,
} from './shared';

const importAnalysisConfigReason =
  'config.imports must be an object when configured.';
const vueImportParserConfigReason =
  'config.imports.vue must be "heuristic" or "compiler-sfc".';

function isSupportedVueParser(value: unknown): boolean {
  return value === 'heuristic' || value === 'compiler-sfc';
}

function validateImportsRecord(
  value: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (value.vue === undefined) return;
  if (isSupportedVueParser(value.vue)) return;
  addConfigIssue(ctx, ['imports', 'vue'], vueImportParserConfigReason);
}

export function validateImports(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(ctx, ['imports'], importAnalysisConfigReason);
    return;
  }
  validateImportsRecord(value, ctx);
}
