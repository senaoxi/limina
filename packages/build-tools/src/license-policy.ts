export const allowedLicenses: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MPL-2.0',
];

export interface BundledDependency {
  name: string;
  version: string;
  license: string;
}

interface DependencyMetadata {
  name?: string | null;
  version?: string | null;
  license?: string | null;
}

export function collectBundledDependencies(
  dependencies: readonly DependencyMetadata[],
): BundledDependency[] {
  const entries = new Map<string, BundledDependency>();
  for (const dependency of dependencies) {
    const { name, version, license } = dependency;
    if (!name || !version || !license) {
      throw new Error(
        'Bundled dependencies require name, version and license.',
      );
    }
    if (!allowedLicenses.includes(license)) {
      throw new Error(`Prohibited license: ${name}@${version}: ${license}`);
    }
    const key = `${name}@${version}`;
    if (entries.has(key) && entries.get(key)!.license !== license) {
      throw new Error(`Conflicting bundled licenses: ${key}`);
    }
    entries.set(key, { name, version, license });
  }
  return entries
    .values()
    .toArray()
    .toSorted((left, right) => {
      const a = `${left.name}@${left.version}`;
      const b = `${right.name}@${right.version}`;
      return Number(a > b) - Number(a < b);
    });
}
