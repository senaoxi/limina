import type {
  VueSemanticAdapter,
  VueSemanticAdapterFamily,
  VueSemanticVersionTuple,
} from './vue-semantic-types';

interface NumericVersion {
  major: number;
  minor: number;
  patch: number;
}

interface AdapterContract {
  family: VueSemanticAdapterFamily;
  languageCoreMajor: number;
  languageCoreMinor: number;
  maximumPatch: number;
  minimumPatch: number;
  volarMaximumPatch: number;
  volarMinimumPatch: number;
}

const adapterContracts: readonly AdapterContract[] = [
  {
    family: 'vue-tsc-2.2',
    languageCoreMajor: 2,
    languageCoreMinor: 2,
    maximumPatch: 12,
    minimumPatch: 0,
    volarMaximumPatch: 28,
    volarMinimumPatch: 11,
  },
  {
    family: 'vue-tsc-3.2',
    languageCoreMajor: 3,
    languageCoreMinor: 2,
    maximumPatch: 4,
    minimumPatch: 0,
    volarMaximumPatch: 27,
    volarMinimumPatch: 27,
  },
];

const supportedTypeScriptMinorRanges = [
  { major: 5, maximumMinor: 9, minimumMinor: 4 },
  { major: 6, maximumMinor: 0, minimumMinor: 0 },
] as const;

function parseNumericVersion(version: string): NumericVersion | null {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version);
  if (match?.groups === undefined) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

function hasMajorMinor(
  version: NumericVersion | null,
  major: number,
  minor: number,
): boolean {
  return version?.major === major && version.minor === minor;
}

function isPatchWithin(
  version: NumericVersion | null,
  minimum: number,
  maximum: number,
): boolean {
  if (version === null) return false;
  return version.patch >= minimum && version.patch <= maximum;
}

function supportsTypeScript(version: NumericVersion | null): boolean {
  if (version === null) return false;
  return supportedTypeScriptMinorRanges.some((range) =>
    [
      version.major === range.major,
      version.minor >= range.minimumMinor,
      version.minor <= range.maximumMinor,
    ].every(Boolean),
  );
}

function matchesAdapterContract(
  tuple: VueSemanticVersionTuple,
  contract: AdapterContract,
): boolean {
  const vueTsc = parseNumericVersion(tuple.vueTsc);
  const languageCore = parseNumericVersion(tuple.languageCore);
  const volarTypeScript = parseNumericVersion(tuple.volarTypeScript);
  const typeScript = parseNumericVersion(tuple.typeScript);
  return [
    hasMajorMinor(
      vueTsc,
      contract.languageCoreMajor,
      contract.languageCoreMinor,
    ),
    isPatchWithin(vueTsc, contract.minimumPatch, contract.maximumPatch),
    hasMajorMinor(
      languageCore,
      contract.languageCoreMajor,
      contract.languageCoreMinor,
    ),
    tuple.vueTsc === tuple.languageCore,
    hasMajorMinor(volarTypeScript, 2, 4),
    isPatchWithin(
      volarTypeScript,
      contract.volarMinimumPatch,
      contract.volarMaximumPatch,
    ),
    supportsTypeScript(typeScript),
  ].every(Boolean);
}

function resolveAdapterFamily(
  tuple: VueSemanticVersionTuple,
): VueSemanticAdapterFamily | null {
  const contract = adapterContracts.find((candidate) =>
    matchesAdapterContract(tuple, candidate),
  );
  return contract?.family ?? null;
}

export function formatVueSemanticVersionTuple(
  tuple: VueSemanticVersionTuple,
): string {
  return `vue-tsc ${tuple.vueTsc}, @vue/language-core ${tuple.languageCore}, @volar/typescript ${tuple.volarTypeScript}, TypeScript ${tuple.typeScript}`;
}

export function resolveVueSemanticAdapter(
  tuple: VueSemanticVersionTuple,
): VueSemanticAdapter {
  const family = resolveAdapterFamily(tuple);
  if (family !== null) return { family, kind: 'supported' };
  return {
    kind: 'unsupported',
    reason: `Unsupported vue-tsc toolchain: ${formatVueSemanticVersionTuple(tuple)}.`,
  };
}

export function isSupportedVueSemanticVersionTuple(
  tuple: VueSemanticVersionTuple,
): boolean {
  return resolveVueSemanticAdapter(tuple).kind === 'supported';
}
