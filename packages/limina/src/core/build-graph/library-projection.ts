import path from 'pathe';
import ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import {
  collectLibrarySelections,
  type LibrarySelection,
} from '../typescript-semantic/library-selection';
import { createRelativePath } from './generated/paths';
import { stringifyJson } from './problems';
import type { GeneratedTsconfigGraphResult, SourceProject } from './types';

export interface LibraryProjectionReceipt {
  scope: 'library-selection';
  version: 1;
  compilerVersion: string;
  checkerName: string;
  sourceConfig: string;
  generatedConfig: string;
  libReplacement?: boolean;
  selections: LibrarySelection[];
  families: string[];
}

function family(entry: LibrarySelection): string {
  return entry.libraryName.split('/').slice(0, 2).join('/');
}

/**
Forward library resolution to the original file; never copy its declarations.
*/
export function libraryProjectionFiles(
  receipt: LibraryProjectionReceipt,
): Map<string, string> {
  return new Map(
    receipt.selections
      .filter((entry) => receipt.families.includes(family(entry)))
      .map((entry) => {
        const file = path.join(
          path.dirname(receipt.generatedConfig),
          'node_modules',
          entry.libraryName,
          'package.json',
        );
        return [
          file,
          stringifyJson({ types: createRelativePath(file, entry.target) }),
        ];
      }),
  );
}

function hasSameTargets(left: LibrarySelection[], right: LibrarySelection[]) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.fileName === right[index]?.fileName &&
        entry.libraryName === right[index]?.libraryName &&
        entry.target === right[index]?.target,
    )
  );
}

export function projectLibraryInputs(input: {
  project: SourceProject;
  generatedConfigPath: string;
  cache?: NativeAnalysisCache;
}): ReadonlyMap<string, string> {
  const { project, generatedConfigPath, cache } = input;
  const compiler =
    project.context.vueSemanticIdentity?.toolchain.tsModule ?? ts;
  const base = { compiler, libReplacement: project.options.libReplacement };
  const selections = collectLibrarySelections({
    kind: 'source',
    ...base,
    configPath: project.configPath,
    cache,
  });
  const generated = collectLibrarySelections({
    kind: 'projection',
    ...base,
    configPath: generatedConfigPath,
  });
  // Include an existing forwarded family even when it currently matches: removing
  // it on regeneration would expose the original drifting lookup again.
  const families = [
    ...new Set(
      [...selections, ...generated]
        .filter((entry) => entry.replacement)
        .map(family),
    ),
  ];
  const receipt: LibraryProjectionReceipt = {
    scope: 'library-selection',
    version: 1,
    compilerVersion: compiler.version,
    checkerName: project.checkerName,
    sourceConfig: project.configPath,
    generatedConfig: generatedConfigPath,
    libReplacement: project.options.libReplacement,
    selections,
    families,
  };
  const files = libraryProjectionFiles(receipt);
  const projected = collectLibrarySelections({
    kind: 'projection',
    ...base,
    configPath: generatedConfigPath,
    files,
  });
  if (!hasSameTargets(selections, projected))
    throw new Error(
      `Library selection projection failed: ${generatedConfigPath}`,
    );
  (project.libraryProjections ??= []).push(receipt);
  return files;
}

export function isValidLibraryProjection(input: {
  receipt: LibraryProjectionReceipt;
  cache?: NativeAnalysisCache;
  files?: ReadonlyMap<string, string>;
  compiler?: typeof ts;
}): boolean {
  const { receipt, cache, files } = input;
  const compiler = input.compiler ?? ts;
  if (receipt.compilerVersion !== compiler.version) return false;
  const base = { compiler, libReplacement: receipt.libReplacement };
  const source = collectLibrarySelections({
    kind: 'source',
    ...base,
    configPath: receipt.sourceConfig,
    cache,
  });
  if (JSON.stringify(source) !== JSON.stringify(receipt.selections))
    return false;
  if (
    files !== undefined &&
    [...libraryProjectionFiles(receipt)].some(
      ([file, content]) => files.get(file) !== content,
    )
  )
    return false;
  return hasSameTargets(
    source,
    collectLibrarySelections({
      kind: 'projection',
      ...base,
      configPath: receipt.generatedConfig,
      files,
    }),
  );
}

export function hasValidLibraryProjections(
  graph: Pick<
    GeneratedTsconfigGraphResult,
    'libraryProjections' | 'typeInputProjections' | 'generatedFiles'
  >,
  cache: NativeAnalysisCache,
): boolean {
  const receipts = graph.libraryProjections ?? [];
  return (
    graph.typeInputProjections?.length === receipts.length &&
    graph.typeInputProjections.every((typeInput) =>
      receipts.some(
        (receipt) =>
          receipt.generatedConfig === typeInput.generatedConfig &&
          receipt.sourceConfig === typeInput.sourceConfig &&
          receipt.libReplacement === typeInput.generatedOptions.libReplacement,
      ),
    ) &&
    receipts.every((receipt) =>
      isValidLibraryProjection({
        receipt,
        cache,
        files: graph.generatedFiles,
      }),
    )
  );
}

export function assertExecutionLibraryProjections(
  graph: GeneratedTsconfigGraphResult,
  inputs: ReadonlySet<string>,
): void {
  const receipts = graph.libraryProjections ?? [];
  for (const receipt of receipts) {
    if (!inputs.has(receipt.generatedConfig)) continue;
    const compiler =
      graph.governedSources.get(receipt.checkerName)?.get(receipt.sourceConfig)
        ?.context.vueSemanticIdentity?.toolchain.tsModule ?? ts;
    if (!isValidLibraryProjection({ receipt, compiler }))
      throw new Error(
        `Compiler library selections changed: ${receipt.sourceConfig}`,
      );
  }
}
