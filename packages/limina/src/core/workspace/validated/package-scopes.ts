import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { ValidatedWorkspaceContext } from './types';

export type PackageScopeRole = 'active' | 'extended' | 'boundary';

export interface RegionPackageManifest {
  path: string;
  directory: string;
  role: PackageScopeRole;
}

/**
Index the directory containing the manifest. A linked manifest can live elsewhere.
*/
export class RegionPackageScopes {
  readonly #nearest = new Map<string, string | undefined>();
  readonly #compilerNearest = new Map<string, string | undefined>();
  readonly #directories = new Map<string, string>();

  readonly manifests: RegionPackageManifest[];

  constructor(
    context: ValidatedWorkspaceContext,
    canonical: (file: string) => string,
  ) {
    const scopes = new Map<string, PackageScopeRole>();
    for (const descriptor of context.descriptorCandidates)
      if (descriptor.kind === 'package-json')
        scopes.set(descriptor.path, 'boundary');
    for (const boundary of context.boundaries)
      if (boundary.kind === 'package-scope')
        scopes.set(boundary.packageJsonPath, 'boundary');
    for (const scope of context.extendedPackageScopes)
      scopes.set(scope.packageJsonPath, 'extended');
    for (const package_ of context.packages)
      scopes.set(path.join(package_.directory, 'package.json'), 'active');
    this.manifests = [...scopes].map(([file, role]) => {
      const directory = canonical(path.dirname(file));
      const manifest = normalizeAbsolutePath(file);
      if (role !== 'boundary') this.#directories.set(directory, manifest);
      return { path: manifest, directory, role };
    });
  }

  #find(
    start: string,
    cache: Map<string, string | undefined>,
    activeDirectory?: (directory: string) => string | undefined,
  ): string | undefined {
    let directory = start;
    while (!cache.has(directory)) {
      // TypeScript searches parents of the spelled file name. A link to a
      // package exposes its manifest, a link to its src directory may not.
      const physical = activeDirectory ? activeDirectory(directory) : directory;
      const scope =
        physical === undefined ? undefined : this.#directories.get(physical);
      if (physical === undefined || scope !== undefined) {
        cache.set(directory, scope);
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const scope = cache.get(directory);
    cache.set(start, scope);
    return scope;
  }

  forFile(canonicalFile: string): string | undefined {
    return this.#find(path.dirname(canonicalFile), this.#nearest);
  }

  forCompilerFile(
    file: string,
    activeDirectory: (directory: string) => string | undefined,
  ): string | undefined {
    return this.#find(
      path.dirname(file),
      this.#compilerNearest,
      activeDirectory,
    );
  }
}
