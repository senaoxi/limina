import { LiminaDependencyError } from '../../dependency-contract';
import type { FrameworkSemanticFailureStage } from '../framework-semantic/contracts';
import type { ImportAnalysisMetricsRecorder } from '../import-analysis/types';
import type { AstroSemanticContextManager } from './context';
import type { AstroSemanticCandidate } from './dependency';
import { collectAstroSemanticCandidates } from './dependency';
import {
  createResolvedAstroCandidate,
  selectCanonicalAstroCandidate,
} from './resolution-candidate';
import type {
  AstroSemanticResolution,
  ResolveAstroSemanticImportOptions,
} from './resolution-types';

export type { AstroSemanticResolution } from './resolution-types';

type ContextResult =
  | {
      context: ReturnType<AstroSemanticContextManager['acquire']>;
      kind: 'supported';
    }
  | Extract<AstroSemanticResolution, { kind: 'unsupported' }>;

function recordMetric(options: {
  count?: number;
  metrics: ImportAnalysisMetricsRecorder | undefined;
  name:
    | 'astro-candidate-count'
    | 'astro-semantic-failure'
    | 'astro-semantic-host-resolution';
}): void {
  options.metrics?.record({
    count: options.count,
    name: options.name,
    provider: 'astro-semantic',
  });
}

function recordFailure(options: {
  metrics: ImportAnalysisMetricsRecorder | undefined;
  stage: FrameworkSemanticFailureStage;
}): void {
  options.metrics?.record({
    kind: options.stage,
    name: 'astro-semantic-failure',
    provider: 'astro-semantic',
  });
}

function classifyContextFailure(error: unknown): FrameworkSemanticFailureStage {
  if (error instanceof LiminaDependencyError) {
    return error.message.startsWith('Unsupported Astro semantic toolchain:')
      ? 'toolchain-compatibility'
      : 'toolchain-resolution';
  }
  return 'context-creation';
}

function getContextFailureScopeIdentity(error: unknown): string | undefined {
  return error instanceof LiminaDependencyError
    ? error.issueIdentity
    : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function acquireContext(
  options: ResolveAstroSemanticImportOptions,
): ContextResult {
  try {
    return {
      context: options.manager.acquire(options.project),
      kind: 'supported',
    };
  } catch (error) {
    const stage = classifyContextFailure(error);
    recordFailure({ metrics: options.metrics, stage });
    return {
      kind: 'unsupported',
      reason: formatError(error),
      scopeIdentity: getContextFailureScopeIdentity(error),
      stage,
    };
  }
}

function recordResolutionFailure(options: {
  metrics: ImportAnalysisMetricsRecorder | undefined;
  resolution: AstroSemanticResolution;
}): void {
  if (options.resolution.kind !== 'unsupported') return;
  recordFailure({
    metrics: options.metrics,
    stage: options.resolution.stage,
  });
}

function resolveCandidates(options: {
  candidates: readonly AstroSemanticCandidate[];
  context: ReturnType<AstroSemanticContextManager['acquire']>;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): AstroSemanticResolution {
  try {
    const hostResolutionCount = new Set(
      options.candidates.map((candidate) => candidate.containingSourceFile),
    ).size;
    recordMetric({
      count: hostResolutionCount,
      metrics: options.metrics,
      name: 'astro-semantic-host-resolution',
    });
    const resolvedByLiteral = options.context.resolveModuleNameLiterals(
      options.candidates.map((candidate) => candidate.literal),
    );
    const resolution = selectCanonicalAstroCandidate(
      options.candidates.map((candidate) =>
        createResolvedAstroCandidate({
          candidate,
          context: options.context,
          resolvedByLiteral,
        }),
      ),
    );
    recordResolutionFailure({ metrics: options.metrics, resolution });
    return resolution;
  } catch (error) {
    recordFailure({ metrics: options.metrics, stage: 'module-resolution' });
    return {
      kind: 'unsupported',
      reason: formatError(error),
      stage: 'module-resolution',
    };
  }
}

export function resolveAstroSemanticImport(
  options: ResolveAstroSemanticImportOptions,
): AstroSemanticResolution {
  const context = acquireContext(options);
  if (context.kind === 'unsupported') return context;
  const dependency = collectAstroSemanticCandidates({
    context: context.context,
    importRecord: options.importRecord,
  });
  if (dependency.kind === 'unsupported') {
    recordFailure({ metrics: options.metrics, stage: dependency.stage });
    return dependency;
  }
  recordMetric({
    count: dependency.candidates.length,
    metrics: options.metrics,
    name: 'astro-candidate-count',
  });
  return resolveCandidates({
    candidates: dependency.candidates,
    context: context.context,
    metrics: options.metrics,
  });
}
