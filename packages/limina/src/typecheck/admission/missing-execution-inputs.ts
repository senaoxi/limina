import { parseCheckerProjectConfigForContext } from '#checkers';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import ts from 'typescript';
import type { CandidateBuildPlan } from '../../core/build-graph/analysis-admission';
import { projections } from '../../core/build-graph/compilation-projection';
import type { GovernedSourceUnit } from '../../core/build-graph/types';
import { qualifyNativeEvidence } from '../../domain/analysis/native-context';
import type {
  NativeEvidenceSnapshot,
  NativeRequest,
} from '../../domain/analysis/native-evidence';
import type { TypecheckTarget } from '../targets';
import type { ExecutionAdmission } from './execution-admission';
import { collectExecutionReferenceClosure } from './reference-closure';

interface MissingInput {
  graph: GeneratedTsconfigGraphResult;
  target: TypecheckTarget;
  root: string;
}
function moduleMode(request: NativeRequest): ts.ResolutionMode {
  if (request.resolutionMode === String(ts.ModuleKind.ESNext))
    return ts.ModuleKind.ESNext;
  return request.resolutionMode === String(ts.ModuleKind.CommonJS)
    ? ts.ModuleKind.CommonJS
    : undefined;
}
function moduleCandidates(
  input: MissingInput,
  request: NativeRequest,
  config: string,
): string[] {
  if (!isModuleSourceRequest(request)) return [];
  const source = governedSource(input, config);
  return source === undefined
    ? []
    : sourceModuleCandidates({ source, root: input.root }, request);
}
function sourceModuleCandidates(
  input: { source: GovernedSourceUnit; root: string },
  request: NativeRequest,
): string[] {
  const { source } = input;
  if (source.semanticAuthority.family !== 'typescript') return [];
  const parsed = parseCheckerProjectConfigForContext({
    configPath: source.configPath,
    context: source.context,
    projectRootDir: input.root,
    allowNoInputDiagnostics: true,
  });
  const result = ts.resolveModuleName(
    request.specifier,
    request.sourceFile!.lexicalPath,
    parsed.options,
    ts.sys,
    undefined,
    undefined,
    moduleMode(request),
  );
  return unresolvedCandidates(result);
}
function unresolvedCandidates(
  result: ts.ResolvedModuleWithFailedLookupLocations,
): string[] {
  return result.resolvedModule === undefined
    ? failedModuleCandidates(result)
    : [];
}
function failedModuleCandidates(
  result: ts.ResolvedModuleWithFailedLookupLocations,
): string[] {
  const failed =
    (result as typeof result & { failedLookupLocations?: readonly string[] })
      .failedLookupLocations ?? [];
  return failed.filter((file) => !ts.sys.fileExists(file));
}
function missingRequest(
  input: MissingInput,
  pair: { snapshot: NativeEvidenceSnapshot; requestId: string },
  configs: ReadonlySet<string>,
): Set<string>[] {
  const request = pair.snapshot.requests.find(
    (item) => item.id === pair.requestId,
  );
  return request === undefined
    ? []
    : bindMissingContext(input, { request, snapshot: pair.snapshot }, configs);
}
function bindMissingContext(
  input: MissingInput,
  evidence: Pick<RequestContext, 'request' | 'snapshot'>,
  configs: ReadonlySet<string>,
): Set<string>[] {
  const { request } = evidence;
  const context = currentContext(input.graph, request.consumerContextId);
  return context === undefined
    ? []
    : qualifiedMissingRequest(input, { ...evidence, context }, configs);
}
interface RequestContext {
  request: NativeRequest;
  snapshot: NativeEvidenceSnapshot;
  context: NonNullable<ReturnType<typeof projections.get>>['contexts'][number];
}
function qualifiedMissingRequest(
  input: MissingInput,
  evidence: RequestContext,
  configs: ReadonlySet<string>,
): Set<string>[] {
  const { request, context } = evidence;
  if (
    !configs.has(context.inputs.config) ||
    !qualifyNativeEvidence(request.origin, context, 'locked-fact').eligible
  )
    return [];
  const paths = missingPathCandidates(evidence);
  return [
    new Set([
      ...paths,
      ...moduleCandidates(input, request, context.inputs.config),
    ]),
  ];
}
/**
Missing alternatives stay grouped by request; two possible producers never become two mandatory producers.
*/
export function missingExecutionInputs(
  admission: ExecutionAdmission,
  target: TypecheckTarget,
): Set<string>[] {
  const config = admission.preflight.config;
  const graph = admission.graph;
  const configs = collectExecutionReferenceClosure(
    graph,
    target,
    config,
  ).configs;
  const input = { graph, target, root: config.rootDir };
  return (graph.dependencyAnalysis?.nativeEvidence ?? []).flatMap(
    ({ snapshot }) =>
      snapshot.resolutions
        .filter((resolution) => resolution.state === 'unresolved')
        .flatMap((resolution) =>
          missingRequest(
            input,
            { snapshot, requestId: resolution.requestId },
            configs,
          ),
        ),
  );
}

function currentContext(
  graph: GeneratedTsconfigGraphResult,
  contextId: string,
) {
  const candidate = graph.dependencyAnalysis?.candidate;
  return candidate === undefined
    ? undefined
    : registeredContext(candidate, contextId);
}
function registeredContext(candidate: CandidateBuildPlan, contextId: string) {
  return projections
    .get(candidate)
    ?.contexts.find((item) => item.id === contextId);
}
function missingPathCandidates(evidence: RequestContext): string[] {
  const resolution = evidence.snapshot.resolutions.find(
    (item) => item.requestId === evidence.request.id,
  )!;
  const candidates =
    resolution.pathSelection?.state === 'missing'
      ? resolution.pathSelection.candidates
      : [];
  return candidates
    .filter(
      (candidate) =>
        !candidate.present && !ts.sys.fileExists(candidate.physicalPath),
    )
    .map((candidate) => candidate.physicalPath);
}

function isModuleSourceRequest(request: NativeRequest): boolean {
  return request.channel === 'module' && request.sourceFile !== null;
}
function governedSource(input: MissingInput, config: string) {
  return input.graph.governedSources
    .get(input.target.checkerName!)
    ?.get(config);
}
