import type ts from 'typescript';
import type {
  FrameworkSemanticCandidate,
  FrameworkSemanticDependencyPreparation,
} from '../framework-semantic/contracts';
import {
  mergePreparedDirectSourceRecords,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import type { ImportRecord } from '../import-analysis/records';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type {
  AstroMaterializedServiceScript,
  AstroSemanticContext,
} from './context';
import type { AstroSemanticCandidate } from './dependency';
import { mapAstroServiceCandidates } from './projection';
import { createResolvedAstroCandidate } from './resolution-candidate';

type AstroCandidate = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike
>;

function createFailure(
  reason: string,
  stage: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'unsupported' }
  >['stage'],
): Extract<FrameworkSemanticDependencyPreparation, { kind: 'unsupported' }> {
  return { kind: 'unsupported', reason, stage };
}

function getSnapshotText(snapshot: ts.IScriptSnapshot): string {
  return snapshot.getText(0, snapshot.getLength());
}

type PreparationFailure = Extract<
  FrameworkSemanticDependencyPreparation,
  { kind: 'unsupported' }
>;

function collectServiceCandidates(options: {
  context: AstroSemanticContext;
  directSourceRecords: ImportRecord[];
  filePath: string;
  services: readonly AstroMaterializedServiceScript[];
  sourceText: string;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): { candidates: AstroCandidate[]; kind: 'supported' } | PreparationFailure {
  const candidates: AstroCandidate[] = [];
  for (const service of options.services) {
    const mapped = mapAstroServiceCandidates({ ...options, service });
    if (mapped.kind === 'unsupported') return mapped;
    candidates.push(...mapped.candidates);
  }
  return { candidates, kind: 'supported' };
}

function resolveCandidates(
  context: AstroSemanticContext,
  candidates: readonly AstroCandidate[],
) {
  const byLiteral = context.resolveModuleNameLiterals(
    candidates.map((candidate) => candidate.literal),
  );
  return candidates.map((candidate) => {
    const result = createResolvedAstroCandidate({
      candidate: candidate as AstroSemanticCandidate,
      context,
      resolvedByLiteral: byLiteral,
    });
    return {
      candidate,
      resolutionMode: result.mode,
      target: result.resolution,
    };
  });
}

function getEvidenceProgram(
  context: AstroSemanticContext,
  resolved: ReturnType<typeof resolveCandidates>,
): ts.Program | undefined {
  return resolved.some((item) => item.target === null)
    ? context.program
    : undefined;
}

function createSupportedPreparation(options: {
  directSourceRecords: ImportRecord[];
  facts: Extract<
    ReturnType<typeof prepareResolvedFrameworkCandidates>,
    { kind: 'supported' }
  >['facts'];
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): FrameworkSemanticDependencyPreparation {
  return {
    directSourceRecords: options.directSourceRecords,
    facts: options.facts,
    kind: 'supported',
    unmapped: options.unmapped,
  };
}

function prepareMappedServices(options: {
  candidates: readonly AstroCandidate[];
  context: AstroSemanticContext;
  directSourceRecords: ImportRecord[];
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): FrameworkSemanticDependencyPreparation {
  const direct = mergePreparedDirectSourceRecords(options.directSourceRecords);
  if (direct.kind === 'unsupported') return direct;
  const resolved = resolveCandidates(options.context, options.candidates);
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'astro',
    framework: 'astro',
    managedOutputLookup: options.managedOutputLookup,
    program: getEvidenceProgram(options.context, resolved),
    resolved,
    tsModule: options.context.toolchain.tsModule,
  });
  if (prepared.kind === 'unsupported') return prepared;
  return createSupportedPreparation({
    directSourceRecords: direct.records,
    facts: prepared.facts,
    unmapped: options.unmapped,
  });
}

function prepareUnchecked(options: {
  context: AstroSemanticContext;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
}): FrameworkSemanticDependencyPreparation {
  const services = options.context.getServiceScripts(options.filePath);
  if (services.length === 0) {
    return createFailure(
      'Astro semantic context did not materialize a primary or extra TypeScript service script.',
      'service-script-materialization',
    );
  }
  const sourceText = getSnapshotText(services[0]!.sourceScript.snapshot);
  const directSourceRecords: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['directSourceRecords'] = [];
  const unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'] = [];
  const mapped = collectServiceCandidates({
    ...options,
    directSourceRecords,
    services,
    sourceText,
    unmapped,
  });
  if (mapped.kind === 'unsupported') return mapped;
  return prepareMappedServices({
    candidates: mapped.candidates,
    context: options.context,
    directSourceRecords,
    managedOutputLookup: options.managedOutputLookup,
    unmapped,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareAstroSemanticDependencies(options: {
  context: AstroSemanticContext;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
}): FrameworkSemanticDependencyPreparation {
  try {
    options.context.assertActive();
    return prepareUnchecked(options);
  } catch (error) {
    return createFailure(
      `Astro semantic service-script preparation failed: ${formatError(error)}`,
      'service-script-materialization',
    );
  }
}
