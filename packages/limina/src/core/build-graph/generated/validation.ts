import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './file-extensions';

interface CheckerSourceConfigCollectionLike {
  buildModulesBySourcePath: Map<string, { kind: string; path: string }>;
  entryConfigPaths: Set<string>;
}

interface SourceProjectLike {
  checkerName: string;
  configPath: string;
  context: CheckerProjectParseContext;
  fileNames: string[];
}

const checkerPresetSuggestionsByExtension = new Map<string, string[]>([
  ['.svelte', ['svelte-check']],
  ['.vue', ['vue-tsc']],
]);

export function addDuplicateCheckerOwnershipProblems(options: {
  checkerCollectionsByName: Map<string, CheckerSourceConfigCollectionLike>;
  checkers: ResolvedCheckerConfig[];
  problems: string[];
  rootDir: string;
}): void {
  const ownersByPresetAndSourcePath = new Map<
    string,
    {
      checkerNames: string[];
      preset: string;
      sourceConfigPath: string;
    }
  >();

  for (const checker of options.checkers) {
    const collection = options.checkerCollectionsByName.get(checker.name);

    if (!collection) {
      continue;
    }

    for (const sourceConfigPath of collection.buildModulesBySourcePath.keys()) {
      const key = JSON.stringify([checker.preset, sourceConfigPath]);
      const ownership = ownersByPresetAndSourcePath.get(key) ?? {
        checkerNames: [],
        preset: checker.preset,
        sourceConfigPath,
      };

      ownership.checkerNames.push(checker.name);
      ownersByPresetAndSourcePath.set(key, ownership);
    }
  }

  for (const ownership of ownersByPresetAndSourcePath.values()) {
    const checkerNames = uniqueSortedStrings(ownership.checkerNames);

    if (checkerNames.length < 2) {
      continue;
    }

    options.problems.push(
      [
        'Duplicate Limina checker ownership:',
        `  preset: ${ownership.preset}`,
        `  source config: ${toRelativePath(options.rootDir, ownership.sourceConfigPath)}`,
        `  checkers: ${checkerNames.join(', ')}`,
        '  reason: checkers with the same preset must not govern the same source tsconfig after solution references are expanded.',
        '  fix: narrow config.checkers.<checker>.include or config.checkers.<checker>.exclude so only one checker owns this tsconfig for the preset.',
      ].join('\n'),
    );
  }
}

export function addOverlappingCheckerEntryProblems(options: {
  checkerCollectionsByName: Map<string, CheckerSourceConfigCollectionLike>;
  checkers: ResolvedCheckerConfig[];
  problems: string[];
  rootDir: string;
}): void {
  const checkerNamesByEntryPath = new Map<string, string[]>();

  for (const checker of options.checkers) {
    const collection = options.checkerCollectionsByName.get(checker.name);

    if (!collection) {
      continue;
    }

    for (const entryConfigPath of collection.entryConfigPaths) {
      checkerNamesByEntryPath.set(entryConfigPath, [
        ...(checkerNamesByEntryPath.get(entryConfigPath) ?? []),
        checker.name,
      ]);
    }
  }

  for (const [entryConfigPath, checkerNames] of checkerNamesByEntryPath) {
    const uniqueCheckerNames = uniqueSortedStrings(checkerNames);

    if (uniqueCheckerNames.length < 2) {
      continue;
    }

    options.problems.push(
      [
        'Duplicate Limina checker entry:',
        `  entry config: ${toRelativePath(options.rootDir, entryConfigPath)}`,
        `  checkers: ${uniqueCheckerNames.join(', ')}`,
        '  reason: checker.include/checker.exclude entry sets must not overlap; capability overlap is allowed only after tsconfig.json references are expanded.',
        '  fix: narrow config.checkers.<checker>.include or config.checkers.<checker>.exclude so each tsconfig.json entry belongs to one checker.',
      ].join('\n'),
    );
  }
}

function createDtsProjectsBySourcePath(
  projects: SourceProjectLike[],
): Map<string, SourceProjectLike[]> {
  const projectsBySourcePath = new Map<string, SourceProjectLike[]>();

  for (const project of projects) {
    projectsBySourcePath.set(project.configPath, [
      ...(projectsBySourcePath.get(project.configPath) ?? []),
      project,
    ]);
  }

  return projectsBySourcePath;
}

function formatUnsupportedSourceConfigExtensionsProblem(options: {
  config: ResolvedLiminaConfig;
  fileNamesByExtension: Map<string, string[]>;
  projects: SourceProjectLike[];
  sourceConfigPath: string;
}): string {
  const checkerLabels = options.projects
    .map((project) => {
      const preset = project.context.checkerPresets[0] ?? 'unknown';

      return `${project.checkerName} (${preset})`;
    })
    .sort((left, right) => left.localeCompare(right));
  const extensionLines = [...options.fileNamesByExtension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([extension, fileNames]) => {
      const suggestions =
        checkerPresetSuggestionsByExtension.get(extension)?.join(', ') ??
        'a checker preset that supports this extension';

      return [
        `  - extension: ${extension}`,
        `    example: ${toRelativePath(options.config.rootDir, fileNames[0]!)}`,
        `    suggested checker: ${suggestions}`,
      ];
    });

  return [
    'Source config contains files unsupported by its checker coverage:',
    `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    `  checkers: ${checkerLabels.join(', ')}`,
    '  unsupported files:',
    ...extensionLines,
    '  reason: every file reached by an effective source config must be supported by at least one checker preset that covers that config.',
    '  fix: add a checker with a matching capability through another tsconfig.json entry that references this source config, or move the files to a config covered by that checker.',
  ].join('\n');
}

export function addUnsupportedSourceConfigExtensionProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProjectLike[];
}): void {
  const projectsBySourceConfigPath = createDtsProjectsBySourcePath(
    options.projects,
  );

  for (const [sourceConfigPath, projects] of projectsBySourceConfigPath) {
    const neutralContext: CheckerProjectParseContext = {
      checkerPresets: ['tsc'],
      extensions: capabilityDiscoveryExtensions,
    };
    const neutralParsed = parseCheckerProjectConfigForContext({
      configPath: sourceConfigPath,
      context: neutralContext,
      projectRootDir: options.config.rootDir,
    });
    const supportedExtensions = new Set(
      projects.flatMap((project) => [
        ...project.context.extensions,
        ...project.fileNames.map(getFileExtension).filter(Boolean),
      ]),
    );
    const unsupportedFilesByExtension = new Map<string, string[]>();

    for (const fileName of neutralParsed.fileNames.map(normalizeAbsolutePath)) {
      const extension = getFileExtension(fileName);

      if (!extension || supportedExtensions.has(extension)) {
        continue;
      }

      unsupportedFilesByExtension.set(extension, [
        ...(unsupportedFilesByExtension.get(extension) ?? []),
        fileName,
      ]);
    }

    if (unsupportedFilesByExtension.size === 0) {
      continue;
    }

    options.problems.push(
      formatUnsupportedSourceConfigExtensionsProblem({
        config: options.config,
        fileNamesByExtension: unsupportedFilesByExtension,
        projects,
        sourceConfigPath,
      }),
    );
  }
}
