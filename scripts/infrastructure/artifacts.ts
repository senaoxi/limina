import {
  collectBundledDependencies,
  type BundledDependency,
} from '@limina/build-tools/license-policy';

export interface PublishedManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function readBundledInventory(
  input: unknown,
  packageName: string,
): BundledDependency[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'Bundled dependency inventory is unavailable. Rebuild the package.',
    );
  }
  const value = input as { packageName?: unknown; dependencies?: unknown };
  if (value.packageName !== packageName || !Array.isArray(value.dependencies)) {
    throw new Error(
      'Bundled dependency inventory belongs to a different package or is invalid.',
    );
  }
  for (const entry of value.dependencies) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      typeof entry.version !== 'string' ||
      typeof entry.license !== 'string'
    ) {
      throw new Error('Bundled dependency entry is invalid.');
    }
  }
  return collectBundledDependencies(value.dependencies);
}

function packageReference(name: string, version: string): string {
  const encodedName = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

export function createPackageSbom(
  manifest: PublishedManifest,
  bundled: readonly BundledDependency[],
  integrity: string,
) {
  const rootReference = packageReference(manifest.name, manifest.version);
  const external = Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'library',
        name: manifest.name,
        version: manifest.version,
        'bom-ref': rootReference,
        purl: rootReference,
      },
      properties: [
        { name: 'limina:artifact-integrity', value: integrity },
        {
          name: 'limina:scope',
          value:
            'Bundled package code and declared external requirements; excludes consumer resolution and external transitive dependencies.',
        },
      ],
    },
    components: bundled.map((dependency) => ({
      type: 'library',
      name: dependency.name,
      version: dependency.version,
      'bom-ref': packageReference(dependency.name, dependency.version),
      purl: packageReference(dependency.name, dependency.version),
      licenses: [{ license: { id: dependency.license } }],
      properties: [{ name: 'limina:relationship', value: 'bundled' }],
    })),
    dependencies: [
      {
        ref: rootReference,
        dependsOn: bundled.map((dependency) =>
          packageReference(dependency.name, dependency.version),
        ),
      },
    ],
    properties: external.map(([name, range]) => ({
      name: `limina:external-requirement:${name}`,
      value: range,
    })),
  };
}
