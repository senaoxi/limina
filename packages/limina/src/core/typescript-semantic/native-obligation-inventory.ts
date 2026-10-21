import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { unqualifiedNativeLoads } from './native-load-qualification';
import { createNativePathObligation } from './native-path-obligations';
import type { NativePathReceipt } from './native-path-selection';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import { createNativeModuleObligation } from './native-program-obligations';
import type {
  NativeModuleObservation,
  NativeProgramRequests,
} from './native-program-requests';
interface Inventory {
  compiler: typeof ts;
  context: NativeEvidenceContext;
  program: NativeObservedProgram;
  frontier: NativeProgramFrontier;
  requests: NativeProgramRequests;
  paths: ReadonlyMap<string, NativePathReceipt>;
  modules: readonly NativeModuleObservation[];
}
export function collectNativeObligations(
  input: Inventory,
): NativeCompilationObligation[] {
  const unqualified = unqualifiedNativeLoads(
    input.program,
    input.requests.entries,
  );
  const paths = [...input.paths].map(([requestId, receipt]) =>
    pathObligation(input, { requestId, receipt }, unqualified),
  );
  const modules = input.modules.map((observation) =>
    createNativeModuleObligation({
      ...input,
      observation,
      sourceLoadGap: sourceLoadGap(unqualified, observation.source),
    }),
  );
  return [...paths, ...modules];
}
function pathObligation(
  input: Inventory,
  occurrence: { requestId: string; receipt: NativePathReceipt },
  unqualified: ReadonlySet<string>,
): NativeCompilationObligation {
  const source = pathSource(input, occurrence.requestId);
  return createNativePathObligation({
    ...input,
    ...occurrence,
    source,
    sourceLoadGap: sourceLoadGap(unqualified, source),
  });
}
function pathSource(
  input: Inventory,
  requestId: string,
): ts.SourceFile | undefined {
  const entry = input.requests.entries.find(
    (item) => item.request.id === requestId,
  );
  if (entry === undefined) return undefined;
  const source = entry.request.sourceFile;
  return source === null
    ? undefined
    : input.program.getSourceFile(source.lexicalPath);
}
function sourceLoadGap(
  unqualified: ReadonlySet<string>,
  source: ts.SourceFile | undefined,
): string | undefined {
  if (source === undefined) return 'path-source-unavailable';
  return unqualified.has(source.fileName)
    ? 'path-fallback-source-classification-unavailable'
    : undefined;
}
