import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { NativePathSelection } from '../../domain/analysis/native-evidence';
import type { ProjectReferenceRedirect } from '../dependency-semantics';

type Compiler = typeof ts;
interface PathCompiler extends Compiler {
  hasExtension(file: string): boolean;
  getSupportedExtensions(options: ts.CompilerOptions): string[][];
}
export interface NativePathReceipt {
  readonly selection: NativePathSelection;
  readonly target?: string;
  readonly redirect?: ProjectReferenceRedirect;
}
interface PathInput {
  compiler: typeof ts;
  host: ts.CompilerHost;
  options: ts.CompilerOptions;
  source: ts.SourceFile;
  reference: ts.FileReference;
  redirect: (candidate: string) => ProjectReferenceRedirect | undefined | null;
}

/** Mirrors the qualified compiler's processSourceFile candidate order, before
 * getSourceFile can confuse a withheld candidate with a nonexistent one. */
export function selectNativePath(input: PathInput): NativePathReceipt {
  const lexicalPath = normalizeAbsolutePath(
    input.compiler.resolveTripleslashReference(
      input.reference.fileName,
      input.source.fileName,
    ),
  );
  const selection: NativePathSelection = {
    lexicalPath,
    candidates: [],
    logicalTarget: null,
    rule: 'typescript-process-source-file-v1',
    state: 'missing',
  };
  return input.options.noResolve
    ? { selection: { ...selection, state: 'disabled', reason: 'noResolve' } }
    : selectCandidates(input, selection);
}
function selectCandidates(
  input: PathInput,
  selection: NativePathSelection,
): NativePathReceipt {
  const candidates = pathCandidates(input, selection.lexicalPath);
  return candidates === undefined
    ? unavailable(selection, 'path-candidate-api-unavailable')
    : probeCandidates(input, selection, candidates);
}
function unavailable(
  selection: NativePathSelection,
  reason: string,
): NativePathReceipt {
  return { selection: { ...selection, state: 'unavailable', reason } };
}
function probeCandidates(
  input: PathInput,
  selection: NativePathSelection,
  candidates: readonly string[],
): NativePathReceipt {
  const observations: NativePathSelection['candidates'][number][] = [];
  for (const candidate of candidates) {
    const receipt = probeCandidate(
      input,
      { ...selection, candidates: observations },
      candidate,
    );
    if (receipt !== undefined) return receipt;
  }
  return exhaustedCandidates(
    input,
    { ...selection, candidates: observations },
    candidates,
  );
}
function probeCandidate(
  input: PathInput,
  selection: NativePathSelection,
  candidate: string,
): NativePathReceipt | undefined {
  const redirect = input.redirect(candidate);
  return redirect === null
    ? unavailable(selection, 'reference-map-unavailable')
    : probePhysical(input, selection, { candidate, redirect });
}
function probePhysical(
  input: PathInput,
  selection: NativePathSelection,
  entry: { candidate: string; redirect: ProjectReferenceRedirect | undefined },
): NativePathReceipt | undefined {
  const { candidate, redirect } = entry;
  const physicalPath = physicalTarget(candidate, redirect);
  const isPresent = input.host.fileExists(physicalPath);
  (selection.candidates as NativePathSelection['candidates'][number][]).push({
    lexicalPath: candidate,
    physicalPath,
    present: isPresent,
  });
  return isPresent
    ? {
        target: physicalPath,
        redirect,
        selection: {
          ...selection,
          state: 'selected',
          logicalTarget: candidate,
        },
      }
    : undefined;
}
export function physicalTarget(
  candidate: string,
  redirect: ProjectReferenceRedirect | undefined,
): string {
  return redirect?.declarationTarget ?? candidate;
}
function exhaustedCandidates(
  input: PathInput,
  selection: NativePathSelection,
  candidates: readonly string[],
): NativePathReceipt {
  const redirect =
    candidates.length === 1 ? input.redirect(candidates[0]!) : undefined;
  return redirect
    ? { redirect, selection: { ...selection, logicalTarget: candidates[0]! } }
    : { selection };
}
function pathCandidates(
  input: PathInput,
  lexical: string,
): string[] | undefined {
  const compiler = input.compiler as PathCompiler;
  if (!hasCandidateApi(compiler)) return undefined;
  return input.options.allowNonTsExtensions
    ? [lexical]
    : supportedCandidates(input, compiler, lexical);
}
function hasCandidateApi(compiler: PathCompiler): boolean {
  return [compiler.hasExtension, compiler.getSupportedExtensions].every(
    (method) => typeof method === 'function',
  );
}
function supportedCandidates(
  input: PathInput,
  compiler: PathCompiler,
  lexical: string,
): string[] | undefined {
  const supported = compiler.getSupportedExtensions(input.options);
  return compiler.hasExtension(lexical)
    ? explicitCandidate(input, lexical, supported.flat())
    : supported[0]?.map((extension) => lexical + extension);
}
function explicitCandidate(
  input: PathInput,
  lexical: string,
  supported: readonly string[],
): string[] {
  const extensions = [
    ...supported,
    ...(input.options.resolveJsonModule ? ['.json'] : []),
  ];
  const canonical = input.host.getCanonicalFileName(lexical);
  return extensions.some((extension) => canonical.endsWith(extension))
    ? [lexical]
    : [];
}
