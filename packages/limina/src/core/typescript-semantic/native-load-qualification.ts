import type ts from 'typescript';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeRequestResult } from './native-program-request-data';

/** Load grants prove reachability, but cannot qualify compiler metadata that
 * was established by an extension fallback from a different occurrence. */
export function unqualifiedNativeLoads(
  program: NativeObservedProgram,
  entries: readonly NativeRequestResult[],
): ReadonlySet<string> {
  const externalTargets = new Set(
    entries
      .filter((entry) => entry.resolution.externalLibrary === true)
      .flatMap((entry) =>
        entry.resolution.target === null
          ? []
          : [entry.resolution.target.lexicalPath],
      ),
  );
  const affected = new Set<string>();
  for (const entry of entries) {
    const source = shadowedSource(program, entry);
    if (source !== undefined)
      markExternalFallback({ externalTargets, affected }, source);
  }
  propagateUnqualifiedLoads(program, entries, affected);
  return affected;
}
function shadowedSource(
  program: NativeObservedProgram,
  entry: NativeRequestResult,
): ts.SourceFile | undefined {
  if (!hasSelectedPath(entry)) return undefined;
  const source = referenceSource(program, entry);
  return source === undefined ? undefined : differentSource(entry, source);
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
): void {
  const roots = new Set(program.getRootFileNames());
  let previousSize = -1;
  while (previousSize !== affected.size) {
    previousSize = affected.size;
    for (const entry of entries)
      propagateEntry({ program, roots, affected }, entry);
  }
}
function propagateEntry(
  input: {
    program: NativeObservedProgram;
    roots: ReadonlySet<string>;
    affected: Set<string>;
  },
  entry: NativeRequestResult,
): void {
  if (!hasAffectedSource(input.affected, entry)) return;
  const target = entry.resolution.target;
  if (target !== null) propagateTarget(input, target.lexicalPath);
}
function propagateTarget(
  input: {
    program: NativeObservedProgram;
    roots: ReadonlySet<string>;
    affected: Set<string>;
  },
  target: string,
): void {
  if (input.roots.has(target)) return;
  if (input.program.getSourceFile(target) !== undefined)
    input.affected.add(target);
}

function hasSelectedPath(entry: NativeRequestResult): boolean {
  return entry.resolution.pathSelection?.state === 'selected';
}
function differentSource(
  entry: NativeRequestResult,
  source: ts.SourceFile,
): ts.SourceFile | undefined {
  return source.fileName === entry.resolution.target?.lexicalPath
    ? undefined
    : source;
}
function markExternalFallback(
  input: { externalTargets: ReadonlySet<string>; affected: Set<string> },
  source: ts.SourceFile,
): void {
  if (input.externalTargets.has(source.fileName))
    input.affected.add(source.fileName);
}

function hasAffectedSource(
  affected: ReadonlySet<string>,
  entry: NativeRequestResult,
): boolean {
  const source = entry.request.sourceFile;
  return source !== null && affected.has(source.lexicalPath);
}
