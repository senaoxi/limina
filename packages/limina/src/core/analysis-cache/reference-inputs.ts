import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';

/**
Include missing declaration outputs: their later creation can change the provider.
*/
export function projectReferenceInputs(
  program: ts.Program,
  tsModule: typeof ts,
): Map<string, string[]> {
  const inputs = new Map<string, string[]>();
  const seen = new Set<ts.ResolvedProjectReference>();
  const references = program.getResolvedProjectReferences() ?? [];
  for (const reference of references)
    collectReference({ reference, inputs, seen, tsModule });
  return inputs;
}

function collectReference(options: {
  reference: ts.ResolvedProjectReference | undefined;
  inputs: Map<string, string[]>;
  seen: Set<ts.ResolvedProjectReference>;
  tsModule: typeof ts;
}): void {
  const reference = options.reference;
  if (reference === undefined) return;
  collectKnownReference(options, reference);
}

function collectKnownReference(
  options: Parameters<typeof collectReference>[0],
  reference: ts.ResolvedProjectReference,
): void {
  if (options.seen.has(reference)) return;
  options.seen.add(reference);
  collectOutputs(reference.commandLine, options.inputs, options.tsModule);
  collectChildren(options, reference.references ?? []);
}

function collectChildren(
  options: Parameters<typeof collectReference>[0],
  children: readonly (ts.ResolvedProjectReference | undefined)[],
): void {
  for (const child of children)
    collectReference({ ...options, reference: child });
}

function collectOutputs(
  commandLine: ts.ParsedCommandLine,
  inputs: Map<string, string[]>,
  tsModule: typeof ts,
): void {
  for (const file of commandLine.fileNames) {
    const outputs = tsModule.getOutputFileNames(
      commandLine,
      file,
      !tsModule.sys.useCaseSensitiveFileNames,
    );
    inputs.set(
      normalizeAbsolutePath(file),
      outputs
        .filter((file) => isDeclarationFile(file))
        .map(normalizeAbsolutePath),
    );
  }
}
