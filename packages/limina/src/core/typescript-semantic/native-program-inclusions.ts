import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import { nativeLibraryFileName } from './native-library-api';
import {
  nativeProgramSource,
  nativeTypeReferenceMode,
} from './native-program-api';
import { nativeRequestId } from './native-program-request-data';
import { moduleChannel } from './native-program-requests';

export interface NativeInclusions {
  readonly requests: readonly {
    readonly requestId: string;
    readonly source: string;
  }[];
  readonly projectReferences: readonly string[];
}

// TypeScript 6.0 FileIncludeKind. Persistent Native composition requires
// these reason records in addition to getSourceFile membership.
const ROOT = 0;
const SOURCE_FROM_PROJECT_REFERENCE = 1;
const OUTPUT_FROM_PROJECT_REFERENCE = 2;
const IMPORT = 3;
const PATH = 4;
const TYPE = 5;
const AUTOMATIC_TYPE = 8;

type IncludeReason =
  | { kind: typeof ROOT; index: number }
  | {
      kind:
        | typeof SOURCE_FROM_PROJECT_REFERENCE
        | typeof OUTPUT_FROM_PROJECT_REFERENCE;
      index: number;
    }
  | {
      kind: typeof IMPORT | typeof PATH | typeof TYPE | 7; // LibReferenceDirective
      file: ts.Path;
      index: number;
    }
  | { kind: 6; index?: number } // LibFile
  | { kind: typeof AUTOMATIC_TYPE; typeReference: string };

type IncludedSource = ts.SourceFile & {
  path: ts.Path;
  redirectInfo?: unknown;
};

export function captureNativeInclusions(
  program: ts.Program,
  requests: readonly NativeRequest[],
  compiler: typeof ts,
): NativeInclusions | undefined {
  if (compiler.version !== '6.0.3') return undefined;
  const reasons = (
    program as ts.Program & {
      getFileIncludeReasons?: () => ReadonlyMap<
        ts.Path,
        readonly IncludeReason[]
      >;
    }
  ).getFileIncludeReasons?.();
  if (reasons === undefined) return undefined;
  const sources = new Map(
    (program.getSourceFiles() as readonly IncludedSource[]).map((source) => [
      source.path,
      source,
    ]),
  );
  const requestIds = new Map<string, { requestId: string; source: string }>();
  const projectReferences = new Set<string>();
  const index = new Map(requests.map((request) => [request.id, request]));
  const context = requests[0]?.origin.context;
  for (const [path, source] of sources) {
    const cause = reasons.get(path);
    // Package-ID aliases can reuse a different source's AST. A partial Program
    // cannot establish the candidate selected by the complete root order.
    if (cause === undefined || source.redirectInfo !== undefined)
      return undefined;
    const file = normalizeAbsolutePath(source.fileName);
    for (const reason of cause) {
      if (reason.kind === ROOT) continue;
      if (isReferenceInput(reason)) {
        projectReferences.add(file);
        continue;
      }
      const id =
        'file' in reason
          ? sourceRequestId({
              program,
              compiler,
              reason,
              context,
              source: sources.get(reason.file),
            })
          : compilerRequestId(reason, program, requests);
      if (id === undefined || !index.has(id)) return undefined;
      const previous = requestIds.get(id);
      if (previous !== undefined && previous.source !== file) return undefined;
      requestIds.set(id, { requestId: id, source: file });
    }
  }
  return {
    requests: requestIds.values().toArray(),
    projectReferences: [...projectReferences],
  };
}

function isReferenceInput(reason: IncludeReason): reason is Extract<
  IncludeReason,
  {
    kind:
      | typeof SOURCE_FROM_PROJECT_REFERENCE
      | typeof OUTPUT_FROM_PROJECT_REFERENCE;
  }
> {
  return [
    SOURCE_FROM_PROJECT_REFERENCE,
    OUTPUT_FROM_PROJECT_REFERENCE,
  ].includes(reason.kind);
}

function compilerRequestId(
  reason: Extract<IncludeReason, { kind: 6 | typeof AUTOMATIC_TYPE }>,
  program: ts.Program,
  requests: readonly NativeRequest[],
): string | undefined {
  const isAutomatic = reason.kind === AUTOMATIC_TYPE;
  const channel = isAutomatic ? 'type-directive' : 'library';
  if (!isAutomatic && reason.index === undefined)
    return requests.find(
      (request) =>
        request.sourceFile === null &&
        request.channel === channel &&
        request.entry.kind === 'config' &&
        request.entry.field === 'defaultLib',
    )?.id;
  const name = isAutomatic
    ? reason.typeReference
    : program.getCompilerOptions().lib?.[reason.index!];
  return requests.find(
    (request) =>
      request.sourceFile === null &&
      request.channel === channel &&
      request.specifier === name,
  )?.id;
}

export function reachableNativeSources(
  entries: Iterable<string>,
  includedBy: (file: string) => Iterable<string>,
): ReadonlySet<string> {
  const reachable = new Set(entries);
  const pending = [...reachable];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const source of includedBy(file)) {
      if (reachable.has(source)) continue;
      reachable.add(source);
      pending.push(source);
    }
  }
  return reachable;
}

function sourceRequestId(input: {
  program: ts.Program;
  compiler: typeof ts;
  reason: Extract<IncludeReason, { file: ts.Path }>;
  context: NativeRequest['origin']['context'] | undefined;
  source: ts.SourceFile | undefined;
}): string | undefined {
  const { program, reason, context, source } = input;
  if (source === undefined || context === undefined) return undefined;
  if (reason.kind === IMPORT) {
    const literal = nativeProgramSource(source).imports[reason.index];
    if (literal === undefined) return undefined;
    return nativeRequestId(context, {
      source,
      position: literal.pos,
      channel: moduleChannel(literal),
      name: literal.text,
      mode: program.getModeForUsageLocation(source, literal),
    });
  }
  return directiveRequestId(input, source, context);
}

function directiveRequestId(
  { program, compiler, reason }: Parameters<typeof sourceRequestId>[0],
  source: ts.SourceFile,
  context: NativeRequest['origin']['context'],
): string | undefined {
  const directive =
    reason.kind === PATH
      ? {
          channel: 'path-directive' as const,
          entry: source.referencedFiles[reason.index],
        }
      : reason.kind === TYPE
        ? {
            channel: 'type-directive' as const,
            entry: source.typeReferenceDirectives[reason.index],
          }
        : {
            channel: 'library' as const,
            entry: source.libReferenceDirectives[reason.index],
          };
  if (directive.entry === undefined) return undefined;
  if (
    directive.channel === 'library' &&
    nativeLibraryFileName(compiler, directive.entry) === undefined
  )
    return undefined;
  return nativeRequestId(context, {
    source,
    position: directive.entry.pos,
    channel: directive.channel,
    name: directive.entry.fileName,
    mode:
      directive.channel === 'type-directive'
        ? nativeTypeReferenceMode(
            compiler,
            directive.entry,
            source,
            (
              program as ts.Program & {
                getCompilerOptionsForFile(
                  file: ts.SourceFile,
                ): ts.CompilerOptions | undefined;
              }
            ).getCompilerOptionsForFile(source),
          )
        : undefined,
  });
}
