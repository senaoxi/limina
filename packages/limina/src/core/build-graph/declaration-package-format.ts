import type { VueSourceProfile } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import { stringifyJson } from './problems';

/** Preserve the package identity of ambiguous .d.ts outputs, including nested
 * scopes. Explicit .d.mts/.d.cts formats need no package marker. */
export function declarationPackageFiles(input: {
  sourceConfig: string;
  parsed: ts.ParsedCommandLine;
  files?: ReadonlyMap<string, string>;
  compiler?: typeof ts;
  vueProfiles?: ReadonlyMap<string, VueSourceProfile>;
}): Map<string, string> {
  const { parsed } = input;
  const compiler = input.compiler ?? ts;
  const formats = new Map<string, string>();
  if (!parsed.options.emitDeclarationOnly || parsed.options.outFile)
    return formats;
  const host = withVirtualResolutionFiles(
    observedResolutionHost(compiler, input.sourceConfig),
    input.files,
  );
  for (const source of parsed.fileNames) {
    const isVueInput = input.vueProfiles?.has(source) === true;
    if (
      !isVueInput &&
      (!/\.(?:tsx?|jsx?)$/.test(source) || /\.d\.ts$/.test(source))
    )
      continue;
    const outputs = compiler.getOutputFileNames(
      parsed,
      source,
      !compiler.sys.useCaseSensitiveFileNames,
    );
    // Qualified Vue profiles retain the compiler's directory projection. The
    // actual CLI reference map independently checks the resulting package scope.
    const output = isVueInput
      ? outputs[0]
      : outputs.find((file) => file.endsWith('.d.ts'));
    if (output === undefined) continue;
    const format = compiler.getImpliedNodeFormatForFile(
      isVueInput ? `${source}.d.ts` : source,
      undefined,
      host,
      {
        ...parsed.options,
        moduleResolution: compiler.ModuleResolutionKind.NodeNext,
      },
    );
    if (format === undefined)
      throw new DeclarationObservationUnavailable(
        `Declaration package format is unavailable: ${source}`,
      );
    const directory = normalizeAbsolutePath(path.dirname(output));
    const type = format === compiler.ModuleKind.ESNext ? 'module' : 'commonjs';
    if (formats.has(directory) && formats.get(directory) !== type)
      throw new DeclarationObservationUnavailable(
        `Conflicting declaration package formats: ${directory}`,
      );
    formats.set(directory, type);
  }
  return packageFiles(formats);
}

/** Validate the actual compiler reference output, independently of the
 * source-free directory projection used to stage package metadata. */
export function validateDeclarationPackageFormat(input: {
  sourceConfig: string;
  sourceFile: string;
  outputFile: string;
  files: ReadonlyMap<string, string>;
  compiler?: typeof ts;
  vueProfiles?: ReadonlyMap<string, VueSourceProfile>;
}): void {
  if (!input.outputFile.endsWith('.d.ts')) return;
  const compiler = input.compiler ?? ts;
  const host = withVirtualResolutionFiles(
    observedResolutionHost(compiler, input.sourceConfig),
    input.files,
  );
  // This queries package scope at the original directory. It creates no
  // SourceFile, root, request, or compilation obligation.
  const sourceProbe = input.vueProfiles?.has(input.sourceFile)
    ? `${input.sourceFile}.d.ts`
    : input.sourceFile;
  const options = { moduleResolution: compiler.ModuleResolutionKind.NodeNext };
  const expected = compiler.getImpliedNodeFormatForFile(
    sourceProbe,
    undefined,
    host,
    options,
  );
  const actual = compiler.getImpliedNodeFormatForFile(
    input.outputFile,
    undefined,
    // Emit creates these directories. Observe physical package.json lookups,
    // including misses, without freezing the output directory's absence.
    withVirtualResolutionFiles(host, undefined, [input.outputFile]),
    options,
  );
  if (expected === undefined || actual !== expected)
    throw new DeclarationObservationUnavailable(
      `Compiler reference output changes package format: ${input.sourceFile}; output: ${input.outputFile}`,
    );
}

function packageFiles(
  formats: ReadonlyMap<string, string>,
): Map<string, string> {
  const retained = new Map<string, string>();
  const directories = formats
    .keys()
    .toArray()
    .sort(
      (left, right) =>
        left.length - right.length || compareCodeUnits(left, right),
    );
  for (const directory of directories) {
    const ancestor = retained
      .keys()
      .filter((candidate) => directory.startsWith(`${candidate}/`))
      .toArray()
      .sort((left, right) => right.length - left.length)[0];
    if (
      ancestor === undefined ||
      retained.get(ancestor) !== formats.get(directory)
    )
      retained.set(directory, formats.get(directory)!);
  }
  return new Map(
    [...retained].map(([directory, type]) => [
      path.join(directory, 'package.json'),
      stringifyJson({ type }),
    ]),
  );
}
