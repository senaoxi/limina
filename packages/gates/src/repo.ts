import { parseDocument } from 'yaml';
import { parseAllowedLicenses } from './licenses.ts';

export function checkLicensePolicy(policy: string, reviewConfig: string): void {
  const supported = parseAllowedLicenses(policy);
  const document = parseDocument(reviewConfig, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error('Dependency review configuration must be valid YAML.');
  }
  const config: unknown = document.toJS();
  const declared: unknown =
    config && typeof config === 'object' && !Array.isArray(config)
      ? Reflect.get(config, 'allow-licenses')
      : undefined;
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    declared.some((license: unknown) => typeof license !== 'string') ||
    new Set(declared).size !== declared.length
  ) {
    throw new Error(
      'Dependency review allow-licenses must be a non-empty array of unique license strings.',
    );
  }
  const missing = supported.filter((license) => !declared.includes(license));
  const unexpected = declared.filter((license) => !supported.includes(license));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Dependency review allow-licenses must match .agents/docs/license-policy.md. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }
}
