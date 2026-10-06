import type { AnalysisInput } from './contracts';
import { analysisHash } from './identity';

export function manifestField(
  content: AnalysisInput,
  field: 'imports' | 'exports',
): AnalysisInput {
  if (content.text === undefined)
    return {
      path: content.path,
      kind: field,
      version: analysisHash(['missing-manifest']),
    };
  const parsed: Record<string, unknown> = JSON.parse(content.text!);
  const value = Object.hasOwn(parsed, field)
    ? ['present', parsed[field]]
    : ['absent'];
  return { path: content.path, kind: field, version: analysisHash(value) };
}

export function requiresManifestInvalidation(
  previous: AnalysisInput | undefined,
  next: AnalysisInput,
): boolean {
  return (
    previous !== undefined &&
    previous.version !== next.version &&
    hasManifestChange(previous, next)
  );
}

function hasNonFieldChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const fields = ['imports', 'exports'];
  if (
    fields.some(
      (field) => Object.hasOwn(before, field) !== Object.hasOwn(after, field),
    )
  )
    return true;
  const withoutFields = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !fields.includes(key)),
    );
  return (
    analysisHash(withoutFields(before)) !== analysisHash(withoutFields(after))
  );
}

function hasManifestChange(
  previous: AnalysisInput,
  next: AnalysisInput,
): boolean {
  return (
    previous.text === undefined ||
    next.text === undefined ||
    hasNonFieldChange(JSON.parse(previous.text), JSON.parse(next.text))
  );
}
