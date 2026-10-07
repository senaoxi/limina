import type { AnalysisReadDescriptor } from '#utils/analysis-input';
import { readFileSync } from 'node:fs';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { createLexicalDirectoryFs } from '../workspace/lexical-directory-fs';
import { inputStat } from './input-state';
function readContent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return undefined;
    throw error;
  }
}
function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}
function readDirectory(
  descriptor: Extract<AnalysisReadDescriptor, { kind: 'ts-directory' }>,
): string[] {
  const [root, extensions, excludes, includes, depth] = descriptor.arguments;
  return ts.sys.readDirectory(
    root,
    optional(extensions),
    optional(excludes),
    optional(includes),
    optional(depth),
  );
}
function readGlob(
  descriptor: Extract<AnalysisReadDescriptor, { kind: 'glob' }>,
): Promise<string[]> {
  const options = {
    ...descriptor.options,
    ...(descriptor.lexicalDirectories && { fs: createLexicalDirectoryFs() }),
  };
  return glob(descriptor.patterns, options);
}
const readers = {
  file: (descriptor: Extract<AnalysisReadDescriptor, { kind: 'file' }>) =>
    inputStat(descriptor.path)?.isFile() ?? false,
  content: (descriptor: Extract<AnalysisReadDescriptor, { kind: 'content' }>) =>
    readContent(descriptor.path),
  'typescript-content': (
    descriptor: Extract<AnalysisReadDescriptor, { kind: 'typescript-content' }>,
  ) => ts.sys.readFile(descriptor.path),
  'ts-directory': readDirectory,
  glob: readGlob,
};
export async function replayDiscoveryRead(
  descriptor: AnalysisReadDescriptor,
): Promise<unknown> {
  const read = readers[descriptor.kind] as (
    input: AnalysisReadDescriptor,
  ) => unknown;
  return read(descriptor);
}
