import { domains, policy } from './contract.ts';
import { hashObject, invariant, object } from './io.ts';
import type { Domain } from './types.ts';

export interface Classification {
  filters: Record<string, string[]>;
  classificationDigest: string;
  affected: Domain[];
}
export function classification(
  paths: string[],
  outputs: unknown,
): Classification {
  const raw = object(outputs);
  const names = ['all_files', ...Object.keys(policy)];
  invariant(
    hashObject(
      Object.keys(raw)
        .filter((key) => key.endsWith('_files') && key !== 'all_files')
        .sort((left, right) => (left < right ? -1 : Number(left > right))),
    ) ===
      hashObject(
        names
          .map((key) => key + '_files')
          .sort((left, right) => (left < right ? -1 : Number(left > right))),
      ),
    'Filter/Policy inventory mismatch',
  );
  const filters: Record<string, string[]> = {};
  for (const name of names) {
    invariant(
      typeof raw[name + '_files'] === 'string',
      'Missing JSON file list',
    );
    const value: unknown = JSON.parse(raw[name + '_files'] as string);
    invariant(
      Array.isArray(value) &&
        value.every((item) => typeof item === 'string') &&
        new Set(value).size === value.length,
      'Invalid file list',
    );
    filters[name] = [...(value as string[])].sort((left, right) =>
      left < right ? -1 : Number(left > right),
    );
    invariant(
      raw[name] === String(value.length > 0),
      'Filter boolean/list disagreement',
    );
    invariant(
      raw[name + '_count'] === String(value.length),
      'Filter count/list disagreement',
    );
  }
  invariant(
    hashObject(filters.all_files) ===
      hashObject(
        [...paths].sort((left, right) =>
          left < right ? -1 : Number(left > right),
        ),
      ),
    'Action/Git path disagreement',
  );
  const known = new Set(Object.keys(policy).flatMap((name) => filters[name]!));
  invariant(
    paths.every((name) => known.has(name)) &&
      [...known].every((name) => paths.includes(name)),
    'Unknown or invented input requires full CI',
  );
  const affected = new Set<Domain>(['repository_gates']);
  for (const [name, impacts] of Object.entries(policy))
    if (filters[name]!.length > 0)
      for (const domain of impacts) affected.add(domain);
  return {
    filters,
    classificationDigest: hashObject(filters),
    affected: domains.filter((domain) => affected.has(domain)),
  };
}
export function classificationBudget(diffs: { paths: string[] }[]): void {
  let total = 0;
  for (const { paths } of diffs) {
    const length = JSON.stringify(paths).length * 2;
    invariant(
      paths.length <= 1000 && length <= 32 * 1024,
      'Diff file list exceeds limit',
    );
    // Each path could match every filter. Bound toJSON(step.outputs), including JSON escaping,
    // before passing it as an environment value; no path is interpolated into shell source.
    const outputBound =
      JSON.stringify(JSON.stringify(paths)).length *
        2 *
        (Object.keys(policy).length + 1) +
      8192;
    invariant(
      outputBound <= 64 * 1024,
      'Action output exceeds safe environment budget',
    );
    total += outputBound;
  }
  invariant(total <= 512 * 1024, 'Classification output budget exceeded');
}
