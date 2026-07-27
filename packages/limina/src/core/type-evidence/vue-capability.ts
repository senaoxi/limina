import { isPlainRecord } from '#utils/values';
import { createRequire } from 'node:module';
import type ts from 'typescript';
import type {
  VolarTypeScriptRuntime,
  VueLanguageRuntime,
  VueTypeEvidenceCapability,
  VueTypeEvidenceVersionTuple,
} from './vue-provider-types';

interface VersionRequirement {
  prefixes: readonly string[];
  value: keyof VueTypeEvidenceVersionTuple;
}

const versionRequirements: readonly VersionRequirement[] = [
  { prefixes: ['3.2'], value: 'vueTsc' },
  { prefixes: ['3.2'], value: 'languageCore' },
  { prefixes: ['2.4'], value: 'volarTypeScript' },
  { prefixes: ['5.9', '6.0'], value: 'typeScript' },
];

const languageCoreFunctions = [
  'createParsedCommandLine',
  'createVueLanguagePlugin',
  'createLanguage',
] as const;

function readPackageVersion(
  requireFromVueTsc: NodeRequire,
  name: string,
): string {
  const manifest = requireFromVueTsc(`${name}/package.json`) as unknown;
  if (!isPlainRecord(manifest) || typeof manifest.version !== 'string') {
    throw new TypeError(`Package ${name} does not expose a string version.`);
  }
  return manifest.version;
}

function hasVersionPrefix(version: string, prefix: string): boolean {
  return version === prefix || version.startsWith(`${prefix}.`);
}

function satisfiesVersionRequirement(
  tuple: VueTypeEvidenceVersionTuple,
  requirement: VersionRequirement,
): boolean {
  return requirement.prefixes.some((prefix) =>
    hasVersionPrefix(tuple[requirement.value], prefix),
  );
}

export function isSupportedVueTypeEvidenceVersionTuple(
  tuple: VueTypeEvidenceVersionTuple,
): boolean {
  return versionRequirements.every((requirement) =>
    satisfiesVersionRequirement(tuple, requirement),
  );
}

function hasFunctionProperties(
  value: Record<string, unknown>,
  names: readonly string[],
): boolean {
  return names.every((name) => typeof value[name] === 'function');
}

function assertLanguageCoreRuntime(value: unknown): VueLanguageRuntime {
  if (
    !isPlainRecord(value) ||
    !hasFunctionProperties(value, languageCoreFunctions)
  ) {
    throw new TypeError(
      '@vue/language-core does not expose the approved Language Service adapter API shape.',
    );
  }
  return value as unknown as VueLanguageRuntime;
}

function assertVolarTypeScriptRuntime(value: unknown): VolarTypeScriptRuntime {
  if (
    !isPlainRecord(value) ||
    !hasFunctionProperties(value, ['createLanguageServiceHost'])
  ) {
    throw new TypeError(
      '@volar/typescript does not expose createLanguageServiceHost.',
    );
  }
  return value as unknown as VolarTypeScriptRuntime;
}

function readVersionTuple(
  requireFromVueTsc: NodeRequire,
): VueTypeEvidenceVersionTuple {
  return {
    languageCore: readPackageVersion(requireFromVueTsc, '@vue/language-core'),
    typeScript: readPackageVersion(requireFromVueTsc, 'typescript'),
    volarTypeScript: readPackageVersion(requireFromVueTsc, '@volar/typescript'),
    vueTsc: readPackageVersion(requireFromVueTsc, 'vue-tsc'),
  };
}

function createUnsupportedTupleReason(
  tuple: VueTypeEvidenceVersionTuple,
): string {
  return `Unsupported Vue checker tuple: vue-tsc ${tuple.vueTsc}, @vue/language-core ${tuple.languageCore}, @volar/typescript ${tuple.volarTypeScript}, TypeScript ${tuple.typeScript}.`;
}

function hasTypeScriptLanguageServiceApi(tsModule: typeof ts): boolean {
  return [
    tsModule.createLanguageService,
    tsModule.ScriptSnapshot?.fromString,
  ].every((value) => typeof value === 'function');
}

function createSupportedCapability(options: {
  requireFromVueTsc: NodeRequire;
  versionTuple: VueTypeEvidenceVersionTuple;
}): VueTypeEvidenceCapability {
  if (!isSupportedVueTypeEvidenceVersionTuple(options.versionTuple)) {
    return {
      kind: 'unsupported',
      reason: createUnsupportedTupleReason(options.versionTuple),
      versionTuple: options.versionTuple,
    };
  }

  const tsModule = options.requireFromVueTsc('typescript') as typeof ts;
  if (!hasTypeScriptLanguageServiceApi(tsModule)) {
    return {
      kind: 'unsupported',
      reason:
        'The resolved TypeScript package does not expose the approved Language Service API shape.',
      versionTuple: options.versionTuple,
    };
  }

  return {
    kind: 'supported',
    languageCore: assertLanguageCoreRuntime(
      options.requireFromVueTsc('@vue/language-core'),
    ),
    tsModule,
    versionTuple: options.versionTuple,
    volarTypeScript: assertVolarTypeScriptRuntime(
      options.requireFromVueTsc('@volar/typescript'),
    ),
  };
}

function formatCapabilityError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveVueTypeEvidenceCapability(
  configPath: string,
): VueTypeEvidenceCapability {
  try {
    const requireFromProject = createRequire(configPath);
    const vueTscManifestPath = requireFromProject.resolve(
      'vue-tsc/package.json',
    );
    const requireFromVueTsc = createRequire(vueTscManifestPath);
    return createSupportedCapability({
      requireFromVueTsc,
      versionTuple: readVersionTuple(requireFromVueTsc),
    });
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: `Unable to initialize the Vue type-evidence adapter: ${formatCapabilityError(error)}`,
    };
  }
}
