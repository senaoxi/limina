import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import type ts from 'typescript';
import { normalizeExtensions } from './extensions';
import type { VueSourceProfile } from './vue-semantic-types';

interface TypeScriptExtensionApi {
  getSupportedExtensions(
    options?: ts.CompilerOptions,
    extraFileExtensions?: readonly ts.FileExtensionInfo[],
  ): readonly (readonly string[])[];
  getSupportedExtensionsWithJsonIfResolveJsonModule(
    options: ts.CompilerOptions | undefined,
    supportedExtensions: readonly (readonly string[])[],
  ): readonly (readonly string[])[];
}

interface ProfileExtensions {
  extensions: readonly string[];
  profile: VueSourceProfile;
}

function isTypeScriptExtensionApi(
  value: typeof ts,
): value is typeof ts & TypeScriptExtensionApi {
  const api = value as typeof ts & Partial<TypeScriptExtensionApi>;
  return (
    typeof api.getSupportedExtensions === 'function' &&
    typeof api.getSupportedExtensionsWithJsonIfResolveJsonModule === 'function'
  );
}

export function getNativeTypeScriptExtensions(tsModule: typeof ts): string[] {
  if (!isTypeScriptExtensionApi(tsModule)) {
    return [
      '.cts',
      '.mts',
      '.tsx',
      '.ts',
      '.cjs',
      '.mjs',
      '.jsx',
      '.js',
      '.json',
    ];
  }
  return normalizeExtensions(
    tsModule
      .getSupportedExtensionsWithJsonIfResolveJsonModule(
        { allowJs: true, resolveJsonModule: true },
        tsModule.getSupportedExtensions({
          allowJs: true,
          resolveJsonModule: true,
        }),
      )
      .flatMap((group) => [...group]),
  );
}

export function createVueExtraFileExtensions(options: {
  extensions: readonly string[];
  tsModule: typeof ts;
}): ts.FileExtensionInfo[] {
  const nativeExtensions = new Set(
    getNativeTypeScriptExtensions(options.tsModule),
  );
  return options.extensions
    .filter((extension) => !nativeExtensions.has(extension))
    .map((extension) => ({
      extension: extension.startsWith('.') ? extension.slice(1) : extension,
      isMixedContent: true,
      scriptKind: options.tsModule.ScriptKind.Deferred,
    }));
}

function assertStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Vue compiler options do not expose ${key}.`);
  }
  if (!value.every((entry) => typeof entry === 'string')) {
    throw new TypeError(`Vue compiler option ${key} must contain strings.`);
  }
  return value as string[];
}

function getVueOptionExtensions(
  vueOptions: unknown,
  key: 'extensions' | 'petiteVueExtensions' | 'vitePressExtensions',
): string[] {
  if (!isPlainRecord(vueOptions)) {
    throw new TypeError(`Vue compiler options do not expose ${key}.`);
  }
  return assertStringArray(vueOptions[key], key);
}

function findMatchingProfile(
  fileName: string,
  profiles: readonly ProfileExtensions[],
): VueSourceProfile | null {
  const match = profiles.find((candidate) =>
    candidate.extensions.some((extension) => fileName.endsWith(extension)),
  );
  if (match === undefined) return null;
  return match.profile;
}

function createProfileEntry(options: {
  externalExtensions: readonly string[];
  fileName: string;
  profiles: readonly ProfileExtensions[];
}): readonly [string, VueSourceProfile] | null {
  const profile = findMatchingProfile(options.fileName, options.profiles);
  if (profile !== null) {
    return [normalizeAbsolutePath(options.fileName), profile];
  }
  if (
    options.externalExtensions.some((extension) =>
      options.fileName.endsWith(extension),
    )
  ) {
    return null;
  }
  throw new Error(
    `Unable to classify Vue semantic source profile for ${options.fileName}.`,
  );
}

function isProfileEntry(
  entry: readonly [string, VueSourceProfile] | null,
): entry is readonly [string, VueSourceProfile] {
  return entry !== null;
}

export function createVueSourceProfiles(options: {
  externalExtensions: readonly string[];
  fileNames: readonly string[];
  tsModule: typeof ts;
  vueOptions: unknown;
}): ReadonlyMap<string, VueSourceProfile> {
  const profiles: readonly ProfileExtensions[] = [
    {
      extensions: getVueOptionExtensions(options.vueOptions, 'extensions'),
      profile: 'vue-sfc',
    },
    {
      extensions: getVueOptionExtensions(
        options.vueOptions,
        'vitePressExtensions',
      ),
      profile: 'vitepress-markdown',
    },
    {
      extensions: getVueOptionExtensions(
        options.vueOptions,
        'petiteVueExtensions',
      ),
      profile: 'petite-vue-html',
    },
  ];
  const nativeExtensions = getNativeTypeScriptExtensions(options.tsModule);
  const entries = options.fileNames
    .filter(
      (fileName) =>
        !nativeExtensions.some((extension) => fileName.endsWith(extension)),
    )
    .map((fileName) =>
      createProfileEntry({
        externalExtensions: options.externalExtensions,
        fileName,
        profiles,
      }),
    )
    .filter(isProfileEntry);
  return new Map(entries);
}
