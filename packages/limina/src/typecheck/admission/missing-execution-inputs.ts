import { parseCheckerProjectConfigForContext } from '#checkers';
import type { PreparedTsconfigGraph } from '#core/build-graph/runner';
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
  graph: PreparedTsconfigGraph;
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
  snapshot: NativeEvidenceSnapshot,
  request: NativeRequest,
  resolution: NativeEvidenceSnapshot['resolutions'][number],
  configs: ReadonlySet<string>,
): Set<string>[] {
  return bindMissingContext(input, { request, snapshot, resolution }, configs);
}
function bindMissingContext(
  input: MissingInput,
  evidence: Pick<RequestContext, 'request' | 'snapshot' | 'resolution'>,
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
  resolution: NativeEvidenceSnapshot['resolutions'][number];
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
    ({ snapshot }) => {
      const unresolved = snapshot.resolutions.filter(
        (resolution) => resolution.state === 'unresolved',
      );
      if (unresolved.length === 0) return [];
      const requests = new Map<string, NativeRequest>();
      for (const request of snapshot.requests)
        if (!requests.has(request.id)) requests.set(request.id, request);
      const resolutions = new Map<
        string,
        NativeEvidenceSnapshot['resolutions'][number]
      >();
      for (const resolution of snapshot.resolutions)
        if (!resolutions.has(resolution.requestId))
          resolutions.set(resolution.requestId, resolution);
      return unresolved.flatMap((resolution) => {
        const request = requests.get(resolution.requestId);
        const firstResolution = resolutions.get(resolution.requestId);
        return request === undefined || firstResolution === undefined
          ? []
          : missingRequest(input, snapshot, request, firstResolution, configs);
      });
    },
  );
}

function currentContext(graph: PreparedTsconfigGraph, contextId: string) {
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
  const { resolution } = evidence;
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
