export interface SourcePackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly name: string;
  readonly version: string;
}

export interface OutputPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly name: string;
  readonly private?: boolean;
  readonly type: 'module';
  readonly types: string;
  readonly version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  return !Array.isArray(value);
}

function createManifestTypeError(manifestPath: string): TypeError {
  return new TypeError(
    `Release fixture package manifest must define string name and version fields: ${manifestPath}`,
  );
}

function assertManifestRecord(options: {
  manifestPath: string;
  value: unknown;
}): asserts options is {
  manifestPath: string;
  value: Record<string, unknown>;
} {
  if (isRecord(options.value)) return;
  throw createManifestTypeError(options.manifestPath);
}

function assertManifestName(options: {
  manifestPath: string;
  value: Record<string, unknown>;
}): asserts options is {
  manifestPath: string;
  value: Record<string, unknown> & { name: string };
} {
  if (typeof options.value.name === 'string') return;
  throw createManifestTypeError(options.manifestPath);
}

function assertManifestVersion(options: {
  manifestPath: string;
  value: Record<string, unknown>;
}): asserts options is {
  manifestPath: string;
  value: Record<string, unknown> & { version: string };
} {
  if (typeof options.value.version === 'string') return;
  throw createManifestTypeError(options.manifestPath);
}

function assertSourceManifestBase(options: {
  manifestPath: string;
  value: unknown;
}): asserts options is {
  manifestPath: string;
  value: Record<string, unknown> & { name: string; version: string };
} {
  assertManifestRecord(options);
  assertManifestName(options);
  assertManifestVersion(options);
}

function assertDependencyRecord(options: {
  manifestPath: string;
  value: unknown;
}): asserts options is {
  manifestPath: string;
  value: Record<string, unknown>;
} {
  if (isRecord(options.value)) return;
  throw new TypeError(
    `Release fixture package dependencies must be an object: ${options.manifestPath}`,
  );
}

function addDependencySpecifier(options: {
  dependencies: Record<string, string>;
  manifestPath: string;
  name: string;
  specifier: unknown;
}): void {
  if (typeof options.specifier !== 'string') {
    throw new TypeError(
      `Release fixture package dependency specifiers must be strings: ${options.manifestPath}`,
    );
  }
  options.dependencies[options.name] = options.specifier;
}

function parseDependencies(options: {
  manifestPath: string;
  value: unknown;
}): Record<string, string> | undefined {
  if (options.value === undefined) return undefined;
  assertDependencyRecord(options);
  const dependencies: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(options.value)) {
    addDependencySpecifier({
      dependencies,
      manifestPath: options.manifestPath,
      name,
      specifier,
    });
  }
  return dependencies;
}

export function parseSourcePackageManifest(
  content: string,
  manifestPath: string,
): SourcePackageManifest {
  const assertion = { manifestPath, value: JSON.parse(content) as unknown };
  assertSourceManifestBase(assertion);
  return {
    dependencies: parseDependencies({
      manifestPath,
      value: assertion.value.dependencies,
    }),
    name: assertion.value.name,
    version: assertion.value.version,
  };
}

function isLocalDependencySpecifier(specifier: string): boolean {
  if (specifier.startsWith('workspace:')) return true;
  if (specifier.startsWith('link:')) return true;
  return specifier.startsWith('file:');
}

function resolvePublishedDependencySpecifier(
  specifier: string,
  dependencyVersion: string | undefined,
): string {
  if (!isLocalDependencySpecifier(specifier)) return specifier;
  return `^${dependencyVersion ?? '1.0.0'}`;
}

function getLicenseField(license: string | false | undefined): {
  license?: string;
} {
  if (license === false) return {};
  return { license: license ?? 'MIT' };
}

function getDependenciesField(
  dependencies: Readonly<Record<string, string>> | undefined,
): { dependencies?: Readonly<Record<string, string>> } {
  if (dependencies === undefined) return {};
  if (Object.keys(dependencies).length === 0) return {};
  return { dependencies };
}

function getPrivateField(value: boolean | undefined): { private?: boolean } {
  return value === undefined ? {} : { private: value };
}

export function createOutputPackageManifest(options: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly license?: string | false;
  readonly name: string;
  readonly private?: boolean;
  readonly version: string;
}): OutputPackageManifest {
  return {
    exports: { '.': './index.js' },
    ...getLicenseField(options.license),
    name: options.name,
    type: 'module',
    types: './index.d.ts',
    version: options.version,
    ...getDependenciesField(options.dependencies),
    ...getPrivateField(options.private),
  };
}

export function createOutputPackageManifestFromSource(options: {
  readonly packageVersions: ReadonlyMap<string, string>;
  readonly source: SourcePackageManifest;
}): OutputPackageManifest {
  const dependencies = options.source.dependencies
    ? Object.fromEntries(
        Object.entries(options.source.dependencies).map(([name, specifier]) => [
          name,
          resolvePublishedDependencySpecifier(
            specifier,
            options.packageVersions.get(name),
          ),
        ]),
      )
    : undefined;
  return createOutputPackageManifest({
    dependencies,
    name: options.source.name,
    version: options.source.version,
  });
}
