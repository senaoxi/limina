import type { PreparedTsconfigGraph } from '#core/build-graph/runner';
import { isDeclarationFile } from '../../core/import-graph/declaration-classifier';
import { compilerFileKey } from '../../core/typescript-semantic/compiler-coverage';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';

export interface IncrementalInputs {
  requiresFullCheck: boolean;
  declarations: Set<string>;
}

type Read = NativeEvidenceSnapshot['resolutions'][number];
type Request = NativeEvidenceSnapshot['requests'][number];

function isUnresolvedInput(request: Request, read: Read): boolean {
  // A package may have removed its last declaration since the previous build.
  return (
    read.state === 'unresolved' &&
    request.channel !== 'library' &&
    read.pathSelection?.state !== 'disabled'
  );
}

function declarationInput(request: Request, read: Read): string | undefined {
  if (read.compilerLoad !== 'loaded' && read.compilerLoad !== 'attempted')
    return undefined;
  // The compiler's bundled libraries are qualified by its toolchain. Library
  // replacement packages, module imports and type directives are user inputs.
  if (request.channel === 'library' && read.externalLibrary !== true)
    return undefined;
  const file = read.target?.lexicalPath;
  return file !== undefined && isDeclarationFile(file)
    ? compilerFileKey(file)
    : undefined;
}

function collectContextInputs(
  snapshot: NativeEvidenceSnapshot,
  contextId: string,
  inputs: IncrementalInputs,
): void {
  const requests = new Map(
    snapshot.requests
      .filter((request) => request.consumerContextId === contextId)
      .map((request) => [request.id, request]),
  );
  inputs.requiresFullCheck ||= snapshot.obligations.some(
    (obligation) =>
      obligation.consumerContextId === contextId &&
      obligation.existence.state === 'absent' &&
      obligation.existence.proof.ruleOrObservation ===
        'compiler-external-library-input-is-not-emitted-by-consumer',
  );
  for (const read of snapshot.resolutions) {
    const request = requests.get(read.requestId);
    if (!request) continue;
    if (isUnresolvedInput(request, read)) inputs.requiresFullCheck = true;
    const file = declarationInput(request, read);
    if (file !== undefined) inputs.declarations.add(file);
  }
}

export function collectIncrementalInputs(
  graph: PreparedTsconfigGraph,
): Map<string, IncrementalInputs> {
  const consumers = new Map<string, IncrementalInputs>();
  const evidence = graph.dependencyAnalysis?.nativeEvidence ?? [];
  for (const { snapshot } of evidence) {
    for (const context of snapshot.contexts) {
      if (context.authority.phase !== 'locked') continue;
      const inputs = consumers.get(context.inputs.config) ?? {
        requiresFullCheck: false,
        declarations: new Set<string>(),
      };
      collectContextInputs(snapshot, context.id, inputs);
      consumers.set(context.inputs.config, inputs);
    }
  }
  return consumers;
}

// Only the final generated leaf establishes which inputs are checker roots.
export function requiresFullCheck(
  inputs: IncrementalInputs | undefined,
  fileNames: readonly string[],
): boolean {
  if (
    inputs === undefined ||
    inputs.requiresFullCheck ||
    inputs.declarations.size === 0
  )
    return inputs?.requiresFullCheck ?? false;
  const roots = new Set(fileNames.map(compilerFileKey));
  return inputs.declarations.values().some((file) => !roots.has(file));
}
