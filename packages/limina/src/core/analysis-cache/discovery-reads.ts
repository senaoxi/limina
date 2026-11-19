import type { AnalysisReadDescriptor } from '#utils/analysis-input';
import { digestFile } from '#utils/file-digest';
import {
  readPhysicalFileBinding,
  readPhysicalFileIdentity,
} from '#utils/physical-file-identity';
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
function readTypeScriptContent(descriptor: {
  path: string;
}): string | undefined {
  return ts.sys.readFile(descriptor.path);
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
  'file-binding': (descriptor: { path: string }) =>
    readPhysicalFileBinding(descriptor.path),
  'file-identity': (descriptor: { path: string }) =>
    readPhysicalFileIdentity(descriptor.path),
  directory: (descriptor: { path: string }) =>
    ts.sys.directoryExists(descriptor.path),
  directories: (descriptor: { path: string }) =>
    ts.sys.getDirectories(descriptor.path),
  realpath: (descriptor: { path: string }) => ts.sys.realpath!(descriptor.path),
  file: (descriptor: Extract<AnalysisReadDescriptor, { kind: 'file' }>) =>
    inputStat(descriptor.path)?.isFile() ?? false,
  content: (descriptor: Extract<AnalysisReadDescriptor, { kind: 'content' }>) =>
    readContent(descriptor.path),
  'file-size': (descriptor: { path: string }) =>
    ts.sys.getFileSize?.(descriptor.path),
  'file-digest': (descriptor: { path: string }) =>
    digestFile(descriptor.path).hash,
  'source-digest': (descriptor: { path: string }) =>
    digestFile(descriptor.path).hash,
  'typescript-content': readTypeScriptContent,
  'config-text': readTypeScriptContent,
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

export function replaySynchronousDiscoveryRead(
  descriptor: Exclude<AnalysisReadDescriptor, { kind: 'glob' }>,
): unknown {
  const read = readers[descriptor.kind] as (
    input: typeof descriptor,
  ) => unknown;
  return read(descriptor);
}
