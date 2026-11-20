import type ts from 'typescript';
import { compilerFileKey } from './compiler-coverage';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeRequestResult } from './native-program-request-data';

/** Load grants prove reachability, but cannot qualify compiler metadata that
 * was established by an extension fallback from a different occurrence. */
export function unqualifiedNativeLoads(
  program: NativeObservedProgram,
  entries: readonly NativeRequestResult[],
  fileKey: (file: string) => string = compilerFileKey,
): ReadonlySet<string> {
  const externalTargets = new Set(
    entries
      .filter((entry) => entry.resolution.externalLibrary === true)
      .flatMap((entry) =>
        entry.resolution.target === null
          ? []
          : [fileKey(entry.resolution.target.lexicalPath)],
      ),
  );
  const affected = new Set<string>();
  const affectedKeys = new Set<string>();
  for (const entry of entries) {
    const source = shadowedSource(program, entry, fileKey);
    if (source !== undefined)
      markExternalFallback(
        { externalTargets, affected, affectedKeys, fileKey },
        source,
      );
  }
  propagateUnqualifiedLoads(program, entries, affected, affectedKeys, fileKey);
  return affected;
}
function shadowedSource(
  program: NativeObservedProgram,
  entry: NativeRequestResult,
  fileKey: (file: string) => string,
): ts.SourceFile | undefined {
  if (!hasSelectedPath(entry)) return undefined;
  const source = referenceSource(program, entry);
  return source === undefined
    ? undefined
    : differentSource(entry, source, fileKey);
}
function referenceSource(
  program: NativeObservedProgram,
  entry: NativeRequestResult,
): ts.SourceFile | undefined {
  const request = entry.request;
  if (request.entry.kind !== 'source') return undefined;
  const source = program.getSourceFile(request.entry.file.lexicalPath);
  return source === undefined
    ? undefined
    : referencedSource(program, source, request.entry.position);
}
function referencedSource(
  program: NativeObservedProgram,
  source: ts.SourceFile,
  position: number,
): ts.SourceFile | undefined {
  const reference = source.referencedFiles.find(
    (item) => item.pos === position,
  );
  return reference === undefined
    ? undefined
    : program.getSourceFileFromReference(source, reference);
}

function propagateUnqualifiedLoads(
  program: NativeObservedProgram,
  entries: readonly NativeRequestResult[],
  affected: Set<string>,
  affectedKeys: Set<string>,
  fileKey: (file: string) => string,
): void {
  const roots = new Set(program.getRootFileNames().map(fileKey));
  let previousSize = -1;
  while (previousSize !== affectedKeys.size) {
    previousSize = affectedKeys.size;
    for (const entry of entries)
      propagateEntry(
        { program, roots, affected, affectedKeys, fileKey },
        entry,
      );
  }
}
function propagateEntry(
  input: {
    program: NativeObservedProgram;
    roots: ReadonlySet<string>;
    affected: Set<string>;
    affectedKeys: Set<string>;
    fileKey: (file: string) => string;
  },
  entry: NativeRequestResult,
): void {
  if (!hasAffectedSource(input.affectedKeys, entry, input.fileKey)) return;
  const target = entry.resolution.target;
  if (target !== null) propagateTarget(input, target.lexicalPath);
}
function propagateTarget(
  input: {
    program: NativeObservedProgram;
    roots: ReadonlySet<string>;
    affected: Set<string>;
    affectedKeys: Set<string>;
    fileKey: (file: string) => string;
  },
  target: string,
): void {
  if (input.roots.has(input.fileKey(target))) return;
  const source = input.program.getSourceFile(target);
  if (source === undefined) return;
  input.affectedKeys.add(input.fileKey(source.fileName));
  input.affected.add(source.fileName);
}

function hasSelectedPath(entry: NativeRequestResult): boolean {
  return entry.resolution.pathSelection?.state === 'selected';
}
function differentSource(
  entry: NativeRequestResult,
  source: ts.SourceFile,
  fileKey: (file: string) => string,
): ts.SourceFile | undefined {
  const target = entry.resolution.target?.lexicalPath;
  return target !== undefined && fileKey(source.fileName) === fileKey(target)
    ? undefined
    : source;
}
function markExternalFallback(
  input: {
    externalTargets: ReadonlySet<string>;
    affected: Set<string>;
    affectedKeys: Set<string>;
    fileKey: (file: string) => string;
  },
  source: ts.SourceFile,
): void {
  const key = input.fileKey(source.fileName);
  if (!input.externalTargets.has(key)) return;
  input.affectedKeys.add(key);
  input.affected.add(source.fileName);
}

function hasAffectedSource(
  affectedKeys: ReadonlySet<string>,
  entry: NativeRequestResult,
  fileKey: (file: string) => string,
): boolean {
  const source = entry.request.sourceFile;
  return source !== null && affectedKeys.has(fileKey(source.lexicalPath));
}
