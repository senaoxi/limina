import { getBuildCheckerSupportedExtensions } from '#checkers';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { getFileExtension } from './generated/file-extensions';

export type SourceFrameworkFamily = 'astro' | 'svelte' | 'vue';

export interface SourceFilePartition {
  astroFiles: string[];
  svelteFiles: string[];
  typescriptFiles: string[];
  vueFiles: string[];
}

export type FrameworkIntentHintKind =
  | 'astro-plugin'
  | 'astro-preset'
  | 'astro-types'
  | 'astro-selector'
  | 'svelte-selector'
  | 'svelte-kit-extends'
  | 'vue-compiler-options'
  | 'vue-selector';

export interface FrameworkIntentHint {
  configPath: string;
  family: SourceFrameworkFamily;
  kind: FrameworkIntentHintKind;
  value: string;
}

export interface AutoFrameworkEvidence {
  configPath: string;
  confirmedCapabilities: SourceFrameworkFamily[];
  filePartition: SourceFilePartition;
  intentHints: FrameworkIntentHint[];
}

export interface FrameworkIntentInspection {
  intentHints: FrameworkIntentHint[];
  problems: string[];
}

type SourceFilePartitionKey = keyof SourceFilePartition;

const partitionKeyByExtension = new Map<string, SourceFilePartitionKey>([
  ['.astro', 'astroFiles'],
  ['.svelte', 'svelteFiles'],
  ['.vue', 'vueFiles'],
  ...getBuildCheckerSupportedExtensions('tsc').map(
    (extension): [string, SourceFilePartitionKey] => [
      extension,
      'typescriptFiles',
    ],
  ),
]);

const capabilityPartitionEntries: readonly [
  SourceFrameworkFamily,
  SourceFilePartitionKey,
][] = [
  ['astro', 'astroFiles'],
  ['svelte', 'svelteFiles'],
  ['vue', 'vueFiles'],
];

function createEmptySourceFilePartition(): SourceFilePartition {
  return {
    astroFiles: [],
    svelteFiles: [],
    typescriptFiles: [],
    vueFiles: [],
  };
}

export function partitionSourceFiles(
  fileNames: readonly string[],
): SourceFilePartition {
  const partition = createEmptySourceFilePartition();
  for (const fileName of uniqueSortedStrings(
    fileNames.map(normalizeAbsolutePath),
  )) {
    const key = partitionKeyByExtension.get(getFileExtension(fileName));
    if (key) partition[key].push(fileName);
  }
  return partition;
}

export function collectConfirmedFrameworkCapabilities(
  partition: SourceFilePartition,
): SourceFrameworkFamily[] {
  return capabilityPartitionEntries
    .filter(([, key]) => partition[key].length > 0)
    .map(([family]) => family);
}

export function createAutoFrameworkEvidence(options: {
  configPath: string;
  filePartition?: SourceFilePartition;
  fileNames?: readonly string[];
  intentHints: FrameworkIntentHint[];
}): AutoFrameworkEvidence {
  const filePartition =
    options.filePartition ?? partitionSourceFiles(options.fileNames ?? []);
  return {
    configPath: normalizeAbsolutePath(options.configPath),
    confirmedCapabilities: collectConfirmedFrameworkCapabilities(filePartition),
    filePartition,
    intentHints: options.intentHints,
  };
}
