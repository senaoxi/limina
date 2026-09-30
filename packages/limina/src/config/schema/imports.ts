import { addConfigIssue, type ConfigValidationContext } from './shared';

const removedImportAnalysisReason =
  'config.imports.vue was removed in the Vue semantic architecture release. Delete config.imports.vue; there is no replacement field.';

export function validateImports(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined) return;
  addConfigIssue(context, ['imports', 'vue'], removedImportAnalysisReason);
}
