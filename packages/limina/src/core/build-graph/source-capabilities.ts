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
  const normalizedFileNames = uniqueSortedStrings(
    fileNames.map(normalizeAbsolutePath),
  );
  for (const fileName of normalizedFileNames) {
    const key = partitionKeyByExtension.get(getFileExtension(fileName));
    if (key) partition[key].push(fileName);
  }
  return partition;
}
