import { readAnalysisInput } from '#utils/analysis-input';
import ts from 'typescript';
import { EpochInputs } from '../../core/analysis-cache/epoch-inputs';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import { isDeclarationInputFile } from '../output/plan';

/**
A completed managed write has a new output receipt, never a rebased input proof.
*/
export function observeManagedOutput(file: string): EpochInputs {
  const observation = new EpochInputs();
  observation.run(() =>
    readAnalysisInput(file, () => ts.sys.readFile(file), 'typescript-content'),
  );
  return observation;
}

export function protectedInputPaths(
  graph: GeneratedTsconfigGraphResult,
): Set<string> {
  const roots = graph.governedSources
    .values()
    .flatMap((units) => units.values())
    .flatMap((unit) => [
      unit.configPath,
      ...unit.ownedFileNames.filter((file) => !isDeclarationInputFile(file)),
    ]);
  const contexts = graph.outputDeclarationCopies
    .values()
    .flatMap((sources) => sources.values());
  const copies = contexts.flatMap((items) =>
    items.flatMap((context) =>
      context.fileNames.filter(isDeclarationInputFile),
    ),
  );
  return new Set([...roots, ...copies]);
}
